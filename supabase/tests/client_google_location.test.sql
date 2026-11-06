begin;
select no_plan();

select has_column('api','clients','google_location','Google metadata is additive');
select col_is_null('api','clients','google_location','legacy clients may omit Google metadata');
select ok(not has_table_privilege('authenticated','api.clients','UPDATE'),'no direct client mutation grant');
select ok(not has_table_privilege('authenticated','api.location_events','SELECT'),'client access grants no GPS evidence access');
select ok(not has_function_privilege('anon','api.execute_client_import(jsonb,text)','EXECUTE'),'anonymous import stays denied');
select is((select pg_catalog.pg_get_userbyid(proowner) from pg_catalog.pg_proc
  where oid='private.execute_client_import(jsonb,text)'::regprocedure),'cirne_route_executor','importer retains its constrained owner');

select id as manager from auth.users where raw_user_meta_data->>'actorKey'='manager_a' \gset
select id as seller, email as seller_email from auth.users where raw_user_meta_data->>'actorKey'='seller_a' \gset
select id as other_seller from auth.users where raw_user_meta_data->>'actorKey'='seller_b' \gset
select id as administrator from auth.users where raw_user_meta_data->>'actorKey'='administrator' \gset
select set_config('test.geo_seller_email', :'seller_email', true);

-- Test command factory is invoker-rights: every mutation still crosses the guarded public RPC.
create function pg_temp.geo_command(p_changes jsonb, p_checksum_seed text) returns jsonb
language sql as $$
  select jsonb_build_object('schemaVersion',1,'sourceName','geo-source-synthetic.xlsx',
    'sourceChecksum',md5(p_checksum_seed)||md5(p_checksum_seed),'totalCount',1,
    'acceptedCount',1,'rejectedCount',0,'issues','[]'::jsonb,
    'rows',jsonb_build_array(jsonb_build_object(
      'rowNumber',2,'externalReference','GOOGLE-422-001','name','Cliente Google sintetico',
      'address','Endereco cadastral original','latitude',-7.115,'longitude',-34.864,
      'portfolioReference','GOOGLE-422','sellerEmail',current_setting('test.geo_seller_email'),
      'status','active') || p_changes));
$$;
select '{"address":"Rua São José, 42 — Loja A","placeId":"ChIJ_Example-422","status":"Localizado","precision":"ROOFTOP"}'::jsonb as geo_a \gset
select '{"address":"Avenida nova, 420","placeId":"ChIJ_Updated-422","status":"Revisar","precision":"APPROXIMATE"}'::jsonb as geo_b \gset
select '{"address":null,"placeId":null,"status":null,"precision":null}'::jsonb as geo_empty \gset

set local role authenticated;
select set_config('request.jwt.claim.sub',:'seller',true);
select throws_ok($$select api.execute_client_import(pg_temp.geo_command('{}','denied'),'cli')$$,
  'P0001','FORBIDDEN','seller cannot import Google metadata');
select set_config('request.jwt.claim.sub',:'manager',true);
select api.execute_client_import(pg_temp.geo_command('{}','legacy-create'),'cli') as legacy_batch \gset
select is((:'legacy_batch')::jsonb->>'acceptedCount','1','legacy import still creates a client');
reset role;
select id as client_id from api.clients where external_reference='GOOGLE-422-001' \gset
select is((select google_location from api.clients where id=:'client_id'),null::jsonb,'legacy insert has SQL NULL metadata');

-- Publish a client with no Google source, before importing its first metadata.
set local role authenticated;
select set_config('request.jwt.claim.sub',:'manager',true);
select api.create_route_draft(jsonb_build_object('schemaVersion',1,'serviceDate','2099-11-12','sellerId',:'seller',
  'stops',jsonb_build_array(jsonb_build_object('clientId',:'client_id','plannedOrder',1,'priority',2)))) as legacy_route \gset
select api.publish_route(((:'legacy_route')::jsonb->>'routeId')::uuid,1);
reset role;
select client_context_snapshot as legacy_snapshot from api.route_version_stops
where route_version_id=((:'legacy_route')::jsonb->>'routeVersionId')::uuid \gset

set local role authenticated;
select set_config('request.jwt.claim.sub',:'manager',true);
select api.execute_client_import(pg_temp.geo_command(jsonb_build_object('googleLocation',(:'geo_a')::jsonb),'geo-a'),'cli') as geo_batch \gset
select is((:'geo_batch')::jsonb->>'acceptedCount','1','Q/U/P/R import is accepted');
select is(api.get_client(:'client_id')->'googleLocation',(:'geo_a')::jsonb,'single-client management exposes source metadata');
select is(api.list_management_clients('GOOGLE-422-001',1,25,null)#>'{clients,0,googleLocation}',(:'geo_a')::jsonb,'management list exposes source metadata');
select is((select item->'googleLocation' from jsonb_array_elements(api.list_import_clients(100)) item
  where item->>'id'=:'client_id'),(:'geo_a')::jsonb,'CLI legacy list exposes source metadata');
select is(api.get_route_planning('2099-11-12',:'seller')#>'{route,stops,0,client,googleLocation}',
  'null'::jsonb,'legacy published planning never adopts current Google metadata');
reset role;
select is((select address from api.clients where id=:'client_id'),'Endereco cadastral original','Google address does not replace cadastral address');
select is((select extensions.st_y(location::extensions.geometry)::numeric from api.clients where id=:'client_id'),-7.115::numeric,'Google metadata does not fabricate coordinates');
select is((select client_context_snapshot from api.route_version_stops where route_version_id=((:'legacy_route')::jsonb->>'routeVersionId')::uuid),
  (:'legacy_snapshot')::jsonb,'legacy published snapshot is unchanged by import');
select ok(exists(select 1 from private.audit_events where target_id=:'client_id' and action='client.imported'
  and after_data->'googleLocation'=(:'geo_a')::jsonb and before_data->'google_location'='null'::jsonb),
  'audit retains previous and effective Google metadata');
select lock_version as accepted_version from api.clients where id=:'client_id' \gset

-- Every malformed candidate rolls back its whole row; a bad JSON value must not abort the batch.
set local role authenticated;
select set_config('request.jwt.claim.sub',:'manager',true);
select is(api.execute_client_import(pg_temp.geo_command(jsonb_build_object('googleLocation',bad.value,'name','MUST NOT PERSIST'),bad.label),'cli')->>'rejectedCount',
  '1','invalid Google metadata rejects only its row: '||bad.label)
from (values
  ('explicit-null','null'::jsonb),('array','[]'::jsonb),('scalar','"x"'::jsonb),('missing-keys','{}'::jsonb),
  ('partial','{"placeId":"ChIJ_42"}'::jsonb),
  ('unknown-key',(:'geo_a')::jsonb||'{"latitude":42}'::jsonb),
  ('wrong-address-type',(:'geo_a')::jsonb||'{"address":42}'::jsonb),
  ('wrong-status-type',(:'geo_a')::jsonb||'{"status":true}'::jsonb),
  ('empty-address',(:'geo_a')::jsonb||'{"address":""}'::jsonb),
  ('blank-precision',(:'geo_a')::jsonb||'{"precision":"   "}'::jsonb),
  ('place-url',(:'geo_a')::jsonb||'{"placeId":"https://example.invalid"}'::jsonb),
  ('place-space',(:'geo_a')::jsonb||'{"placeId":"ChIJ A"}'::jsonb),
  ('long-address',(:'geo_a')::jsonb||jsonb_build_object('address',repeat('a',501))),
  ('long-place',(:'geo_a')::jsonb||jsonb_build_object('placeId',repeat('a',513))),
  ('long-status',(:'geo_a')::jsonb||jsonb_build_object('status',repeat('a',121))),
  ('long-precision',(:'geo_a')::jsonb||jsonb_build_object('precision',repeat('a',81)))
) bad(label,value);
reset role;
select is((select name from api.clients where id=:'client_id'),'Cliente Google sintetico','invalid metadata cannot partially modify client fields');
select is((select lock_version from api.clients where id=:'client_id'),:'accepted_version'::integer,'rejected rows do not advance client version');
select is((select google_location from api.clients where id=:'client_id'),(:'geo_a')::jsonb,'invalid metadata preserves the existing value');
grant cirne_route_executor to postgres with set true;
set local role cirne_route_executor;
select throws_ok(format('update api.clients set google_location=%L::jsonb where id=%L', '{"placeId":"bad?"}', :'client_id'),
  '23514',null,'direct SQL also enforces complete metadata shape');
reset role;
revoke cirne_route_executor from postgres granted by current_user;

set local role authenticated;
select set_config('request.jwt.claim.sub',:'manager',true);
select pg_temp.geo_command(jsonb_build_object('googleLocation',null,'name','MUST NOT PERSIST'),'mixed-batch') as mixed_command \gset
select api.execute_client_import(jsonb_set((:'mixed_command')::jsonb,'{rows}',
  ((:'mixed_command')::jsonb->'rows') || jsonb_build_array(((:'mixed_command')::jsonb#>'{rows,0}') ||
    jsonb_build_object('rowNumber',3,'externalReference','GOOGLE-422-MIXED','name','Valid mixed row','googleLocation',(:'geo_a')::jsonb)))
  || '{"totalCount":2,"acceptedCount":1,"rejectedCount":1}'::jsonb,'cli') as mixed_batch \gset
select is((:'mixed_batch')::jsonb->>'acceptedCount','1','valid sibling row commits alongside rejected Google metadata');
select is((:'mixed_batch')::jsonb->>'rejectedCount','1','mixed batch retains the invalid row rejection');
select is(api.get_client(:'client_id')->>'name','Cliente Google sintetico','mixed batch does not partially update its rejected client');
select is(api.execute_client_import(pg_temp.geo_command(jsonb_build_object('externalReference','GOOGLE-422-BOUNDARY',
  'googleLocation',jsonb_build_object('address',repeat('é',500),'placeId',repeat('a',512),'status',repeat('s',120),'precision',repeat('p',80))),
  'boundary'),'cli')->>'acceptedCount','1','exact maximum lengths and Unicode are accepted');
select api.execute_client_import(pg_temp.geo_command('{}','legacy-preserve'),'cli') as preserve_batch \gset
select is(api.get_client(:'client_id')->'googleLocation',(:'geo_a')::jsonb,'legacy update without object preserves all metadata');
select api.execute_client_import(pg_temp.geo_command(jsonb_build_object('googleLocation',(:'geo_empty')::jsonb),'clear'),'cli') as clear_batch \gset
select is(api.get_client(:'client_id')->'googleLocation',(:'geo_empty')::jsonb,'explicit empty source clears the four metadata values');
select api.execute_client_import(pg_temp.geo_command(jsonb_build_object('googleLocation',(:'geo_a')::jsonb),'restore-a'),'cli') as restored_batch \gset
select is(api.execute_client_import(pg_temp.geo_command(jsonb_build_object('googleLocation',(:'geo_b')::jsonb),'restore-a'),'cli')->>'replayed','true',
  'same source checksum replays the established batch');
select is(api.get_client(:'client_id')->'googleLocation',(:'geo_a')::jsonb,'replay cannot change Google metadata');
reset role;

insert into api.clients(id,external_reference,name,address,google_location)
values ('94220000-0000-4000-8000-000000000002','GOOGLE-422-OUT','Protected client','Protected address',(:'geo_a')::jsonb);
insert into api.client_seller_scopes(client_id,seller_id,assigned_by)
values ('94220000-0000-4000-8000-000000000002',:'other_seller',:'administrator');
set local role authenticated;
select set_config('request.jwt.claim.sub',:'manager',true);
select api.execute_client_import(pg_temp.geo_command(jsonb_build_object('externalReference','GOOGLE-422-OUT','googleLocation',(:'geo_b')::jsonb),'out-of-scope'),'cli') as denied_batch \gset
select is((:'denied_batch')::jsonb#>>'{issues,0,code}','CLIENT_OUT_OF_SCOPE','Google metadata keeps import scope checks');
select is(api.list_management_clients('GOOGLE-422-OUT',1,25,null)#>>'{pagination,totalCount}','0','out-of-scope metadata is not listed');
reset role;
select is((select google_location from api.clients where external_reference='GOOGLE-422-OUT'),(:'geo_a')::jsonb,'out-of-scope metadata is untouched');

-- Publish through the normal API, start a real visit, then import a changed source.
update api.parameter_sets set status='retired' where status='published';
insert into api.parameter_sets(id,version,status,valid_from,published_at,published_by)
values ('94220000-0000-4000-8000-000000000003',422,'published','2099-01-01T00:00:00Z','2099-01-01T00:00:00Z',:'administrator');
set local role authenticated;
select set_config('request.jwt.claim.sub',:'manager',true);
select api.create_route_draft(jsonb_build_object('schemaVersion',1,'serviceDate','2099-11-13','sellerId',:'seller',
  'stops',jsonb_build_array(jsonb_build_object('clientId',:'client_id','plannedOrder',1,'priority',2)))) as route \gset
select is(api.get_route_planning('2099-11-13',:'seller')#>'{route,stops,0,client,googleLocation}',(:'geo_a')::jsonb,'draft planning reads the current source');
select api.publish_route(((:'route')::jsonb->>'routeId')::uuid,1);
reset role;
select id as stop_id, client_context_snapshot as published_snapshot from api.route_version_stops
where route_version_id=((:'route')::jsonb->>'routeVersionId')::uuid \gset
select is((:'published_snapshot')::jsonb->'googleLocation',(:'geo_a')::jsonb,'new publication includes offline source metadata');
set local role authenticated;
select set_config('request.jwt.claim.sub',:'seller',true);
select api.start_visit('94220000-0000-4000-8000-000000000004','94220000-0000-4000-8000-000000000005',
  jsonb_build_object('schemaVersion',1,'offlineId','94220000-0000-4000-8000-000000000006','routeVersionStopId',:'stop_id',
    'deviceStartedAt','2099-11-13T12:00:00Z','location',jsonb_build_object(
      'latitude','-7.114','longitude','-34.863','accuracyM','12','distanceM','5'))) as visit \gset
reset role;
select (:'visit')::jsonb->>'visitId' as visit_id \gset
select context_snapshot as visit_snapshot from api.visits where id=:'visit_id' \gset
select to_jsonb(event) as gps_snapshot from api.location_events event where visit_id=:'visit_id' and kind='start' \gset
select is((:'visit_snapshot')::jsonb#>'{client,googleLocation}',(:'geo_a')::jsonb,'visit pins the published source metadata');

set local role authenticated;
select set_config('request.jwt.claim.sub',:'manager',true);
select api.execute_client_import(pg_temp.geo_command(jsonb_build_object('googleLocation',(:'geo_b')::jsonb,
  'latitude',null,'longitude',null),'geo-b'),'cli') as updated_batch \gset
select is(api.get_client(:'client_id')->'googleLocation',(:'geo_b')::jsonb,'current client shows the changed source');
select is(api.get_client(:'client_id')->'latitude','null'::jsonb,'Google destination remains usable without cadastral coordinates');
select is(api.get_route_planning('2099-11-13',:'seller')#>'{route,stops,0,client,googleLocation}',(:'geo_a')::jsonb,'published planning remains at its historical source');
select set_config('request.jwt.claim.sub',:'seller',true);
select is(api.start_visit('94220000-0000-4000-8000-000000000004','94220000-0000-4000-8000-000000000005',
  jsonb_build_object('schemaVersion',1,'offlineId','94220000-0000-4000-8000-000000000006','routeVersionStopId',:'stop_id',
    'deviceStartedAt','2099-11-13T12:00:00Z','location',jsonb_build_object(
      'latitude','-7.114','longitude','-34.863','accuracyM','12','distanceM','5')))->>'visitId',:'visit_id',
  'visit-start replay after source import returns the original visit');
select set_config('request.jwt.claim.sub',:'manager',true);
select api.get_visit_detail(:'visit_id','94220000-0000-4000-8000-000000000007','cli') as detail \gset
select is((:'detail')::jsonb#>'{context,client,googleLocation}',(:'geo_a')::jsonb,'visit detail uses only the preserved client context');
select is((:'detail')::jsonb#>>'{location,state}','withheld','Google metadata does not grant location evidence capability');
select ok((:'detail')::text !~ '"(latitude|longitude)"','ordinary detail does not expose observed GPS');
select api.change_route_composition(((:'route')::jsonb->>'routeId')::uuid,
  jsonb_build_object('schemaVersion',1,'expectedVersion',2,'reason','Atualizar prioridade e republicar contexto',
    'stops',jsonb_build_array(jsonb_build_object('clientId',:'client_id','plannedOrder',1,'priority',3))),
  '94220000-0000-4000-8000-000000000008','cli') as revision \gset
select api.publish_route(((:'route')::jsonb->>'routeId')::uuid,3);
select is(api.get_route_planning('2099-11-13',:'seller')#>'{route,stops,0,client,googleLocation}',(:'geo_b')::jsonb,'normal successor publication adopts the new source');
select is(api.get_route_planning('2099-11-13',:'seller')#>'{route,stops,0,client,latitude}','null'::jsonb,'new Google snapshot does not invent missing coordinates');
reset role;
select is((select client_context_snapshot from api.route_version_stops where id=:'stop_id'),(:'published_snapshot')::jsonb,'old published stop is unchanged after successor publication');
select is((select context_snapshot from api.visits where id=:'visit_id'),(:'visit_snapshot')::jsonb,'import and route revision preserve visit context byte-for-byte');
select is((select to_jsonb(event) from api.location_events event where visit_id=:'visit_id' and kind='start'),(:'gps_snapshot')::jsonb,
  'import, visit replay and route revision preserve observed GPS, precision, author and timestamps');
select ok(exists(select 1 from private.audit_events where target_id=:'client_id' and action='client.imported'
  and before_data->'google_location'=(:'geo_a')::jsonb and after_data->'googleLocation'=(:'geo_b')::jsonb),
  'source correction audit preserves both Google versions');

insert into api.role_permissions(role_id,permission_code)
select id,'visit.location.read_scoped' from api.roles where code='manager';
set local role authenticated;
select set_config('request.jwt.claim.sub',:'manager',true);
select api.get_visit_detail(:'visit_id','94220000-0000-4000-8000-000000000009','cli') as privileged_detail \gset
select is((:'privileged_detail')::jsonb#>>'{location,state}','available','explicit evidence capability still reveals observed GPS separately');
select is((:'privileged_detail')::jsonb#>'{context,client,googleLocation}',(:'geo_a')::jsonb,'privileged detail keeps historical source independent of GPS');
select set_config('request.jwt.claim.sub',:'other_seller',true);
select throws_ok(format('select api.get_visit_detail(%L,%L,''cli'')',:'visit_id','94220000-0000-4000-8000-000000000010'),
  'P0001','NOT_FOUND','unrelated seller cannot inspect source or GPS in visit detail');
reset role;
select * from finish();
rollback;
