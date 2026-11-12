begin;
select no_plan();

select has_table('api','visit_sales_reports','visit declarations have their own table');
select has_function('api','save_visit_sales',array['uuid','uuid','jsonb'],'direct sales writer exists');
select has_function('api','get_visit_sales',array['uuid','uuid'],'seller can read the canonical declaration');
select ok(not has_table_privilege('authenticated','api.visit_sales_reports','SELECT,INSERT,UPDATE,DELETE'),
  'authenticated has no direct sales DML or reads');
select ok(not has_table_privilege('cirne_visit_sales_executor','api.visits','UPDATE'),
  'sales executor cannot update visits');
select ok(has_column_privilege('cirne_visit_executor','api.clients','id','SELECT')
  and has_column_privilege('cirne_visit_executor','api.clients','location','SELECT'),
  'checkout can read the two client columns it requires');
select ok(not has_table_privilege('cirne_visit_executor','api.clients','SELECT,INSERT,UPDATE,DELETE')
  and not has_column_privilege('cirne_visit_executor','api.clients','name','SELECT'),
  'checkout has no broad client read or DML grant');
select ok(not has_function_privilege('anon','api.save_visit_sales(uuid,uuid,jsonb)','EXECUTE'),
  'anonymous sales writes are denied');
select ok(not has_function_privilege('authenticated','private.sync_event(uuid,jsonb)','EXECUTE'),
  'private sync remains inaccessible to callers');
select ok(not has_function_privilege('authenticated','private.lock_visit_for_sales(uuid,uuid)','EXECUTE'),
  'row locking helper is private');
select ok(not has_function_privilege('authenticated','api.complete_visit_before_sales(uuid,uuid,jsonb)','EXECUTE'),
  'checkout cannot bypass the operation-scoped visibility wrapper');
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid='api.visit_sales_reports'::regclass),
  'sales declarations force RLS');
select ok(not (select rolcanlogin or rolsuper or rolbypassrls from pg_roles where rolname='cirne_visit_sales_executor'),
  'sales executor cannot login or bypass RLS');
select id as seller from auth.users where raw_user_meta_data->>'actorKey'='seller_a' \gset
select id as other from auth.users where raw_user_meta_data->>'actorKey'='seller_b' \gset
select id as manager from auth.users where raw_user_meta_data->>'actorKey'='manager_a' \gset
select id as admin from auth.users where raw_user_meta_data->>'actorKey'='administrator' \gset
select id as blocked from auth.users where raw_user_meta_data->>'actorKey'='blocked' \gset

insert into api.clients(id,name,address,external_reference)
values('44000000-0000-4000-8000-000000000001','Informe venda TESTE','Endereco TESTE','SALES-440');
insert into api.client_seller_scopes(client_id,seller_id,assigned_by)
values('44000000-0000-4000-8000-000000000001',:'seller',:'admin');
set local role authenticated;
select set_config('request.jwt.claim.sub',:'manager',true);
select api.create_route_draft(jsonb_build_object('schemaVersion',1,'serviceDate','2099-11-18','sellerId',:'seller',
  'stops',jsonb_build_array(jsonb_build_object('clientId','44000000-0000-4000-8000-000000000001',
  'plannedOrder',1,'priority',0)))) as route \gset
select api.publish_route(((:'route')::jsonb->>'routeId')::uuid,1);
reset role;
select id as stop from api.route_version_stops
where route_version_id=((:'route')::jsonb->>'routeVersionId')::uuid \gset
set local role authenticated;
select set_config('request.jwt.claim.sub',:'seller',true);
select api.start_visit('44000000-0000-4000-8000-000000000002','44000000-0000-4000-8000-000000000003',
  jsonb_build_object('schemaVersion',1,'offlineId','44000000-0000-4000-8000-000000000004',
    'routeVersionStopId',:'stop','deviceStartedAt','2099-11-18T12:00:00Z')) as visit \gset
select api.save_visit_checkin_evidence('44000000-0000-4000-8000-000000000002','44000000-0000-4000-8000-000000000032',
  jsonb_build_object('schemaVersion',1,'offlineId','44000000-0000-4000-8000-000000000004',
    'evidence',jsonb_build_object('offlineId','44000000-0000-4000-8000-000000000033',
      'capturedAt','2099-11-18T12:00:00Z','location',jsonb_build_object('latitude','-7.115','longitude','-34.864'),
      'issues',jsonb_build_array('camera_unavailable'),'justification','Dispositivo sintetico sem camera')));
select is(api.get_visit_sales('44000000-0000-4000-8000-000000000002','44000000-0000-4000-8000-000000000004'),
  null::jsonb,'no declaration is represented by absence, not zeros');
reset role;
select (:'visit')::jsonb->>'visitId' as visit_id \gset
set local role authenticated;
select set_config('request.jwt.claim.sub',:'manager',true);
select is(api.get_visit_detail(:'visit_id','44000000-0000-4000-8000-000000000005','cli')#>>'{sections,sales,state}',
  'absent','management represents a missing declaration explicitly');
reset role;

-- Prerequisites are synthetic facts; legacy scrap remains at its original sequence.
insert into api.visit_commercial_action_reports(visit_id,competitor_availability,last_event_id,device_saved_at)
values(:'visit_id','not_identified','44000000-0000-4000-8000-000000000006',now());
grant cirne_visit_executor to postgres with set true;
set local role cirne_visit_executor;
insert into api.stock_snapshots(visit_id,heliar_quantity,moura_quantity,last_event_id,device_saved_at,server_saved_at)
values(:'visit_id',7,9,'44000000-0000-4000-8000-000000000030',now(),now());
insert into api.competitor_price_reports(visit_id,parameter_set_id,availability,last_event_id,device_saved_at,server_saved_at)
select id,parameter_set_id,'available','44000000-0000-4000-8000-000000000031',now(),now()
from api.visits where id=:'visit_id';
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub',:'seller',true);
select jsonb_build_object('schemaVersion',1,'eventId','44000000-0000-4000-8000-000000000007',
  'idempotencyKey','44000000-0000-4000-8000-000000000008','operation','visit.scrap.saved.v1',
  'aggregateType','visit','aggregateId','44000000-0000-4000-8000-000000000004','sequence',2,
  'occurredAt','2099-11-18T12:01:00Z','payload',jsonb_build_object('schemaVersion',1,
    'offlineId','44000000-0000-4000-8000-000000000004','deviceSavedAt','2099-11-18T12:01:00Z',
    'availability','none')) as legacy_scrap \gset
select api.sync_event('44000000-0000-4000-8000-000000000002',(:'legacy_scrap')::jsonb) as scrap_confirmation \gset
select jsonb_build_object('schemaVersion',1,'offlineId','44000000-0000-4000-8000-000000000004',
  'deviceCompletedAt','2099-11-18T12:05:00Z','evidence',jsonb_build_object(
    'offlineId','44000000-0000-4000-8000-000000000020','capturedAt','2099-11-18T12:05:00Z',
    'location',jsonb_build_object('latitude','-7.115','longitude','-34.864'),
    'issues',jsonb_build_array('camera_unavailable'),'justification','Dispositivo sintetico sem camera')) as checkout_command \gset
select throws_ok(format('select api.complete_visit(''44000000-0000-4000-8000-000000000002'',
  ''44000000-0000-4000-8000-000000000021'',%L::jsonb)',(:'checkout_command')),
  'P0001','EVENT_OUT_OF_ORDER','checkout RPC also requires a complete sales declaration');
select is(nullif(current_setting('cirne.checkout_source_visit_id',true),''),null::text,
  'failed checkout restores its prior observation context');
reset role;
-- This direct status transition exercises the same non-bypassable guard as checkout.
set local role cirne_visit_executor;
select throws_ok(format('update api.visits set status=''completed'',device_completed_at=now(),
  server_completed_at=now(),completion_payload_hash=repeat(''a'',64) where id=%L',:'visit_id'),
  'P0001','EVENT_OUT_OF_ORDER','an older in-progress visit cannot checkout without sales');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub',:'seller',true);
select jsonb_build_object('schemaVersion',1,'offlineId','44000000-0000-4000-8000-000000000004',
  'expectedVersion',0,'heliarQuantity',0,'americaQuantity',0,'stradaDurexQuantity',0,
  'deviceSavedAt','2099-11-18T12:02:00Z') as first_command \gset
select api.save_visit_sales('44000000-0000-4000-8000-000000000002','44000000-0000-4000-8000-000000000009',
  (:'first_command')::jsonb) as first_sales \gset
select is((:'first_sales')::jsonb->>'version','1','first declaration starts at version one');
select is((:'first_sales')::jsonb->>'heliarQuantity','0','zero Heliar is an explicit answer');
select is((:'first_sales')::jsonb->>'americaQuantity','0','zero America is an explicit answer');
select is((:'first_sales')::jsonb->>'stradaDurexQuantity','0','Strada and Durex share one explicit quantity');
select is(api.save_visit_sales('44000000-0000-4000-8000-000000000002','44000000-0000-4000-8000-000000000009',
  (:'first_command')::jsonb),(:'first_sales')::jsonb,'same direct intention returns identical confirmation');
select set_config('request.jwt.claim.sub',:'manager',true);
select is(api.get_visit_detail(:'visit_id','44000000-0000-4000-8000-000000000024','cli')#>>'{sections,sales,americaQuantity}',
  '0','management preserves explicit zero as available data');
select set_config('request.jwt.claim.sub',:'seller',true);
select throws_ok(format('select api.save_visit_sales(''44000000-0000-4000-8000-000000000002'',
  ''44000000-0000-4000-8000-000000000009'',%L::jsonb)',
  ((:'first_command')::jsonb||'{"heliarQuantity":1}')::text),'P0001','IDEMPOTENCY_KEY_REUSED',
  'reusing the key with a divergent declaration fails');
select throws_ok(format('select api.save_visit_sales(''44000000-0000-4000-8000-000000000002'',
  ''44000000-0000-4000-8000-000000000010'',%L::jsonb)',(:'first_command')),
  'P0001','VERSION_CONFLICT','a stale report version cannot overwrite the declaration');
select throws_ok(format('select api.save_visit_sales(''44000000-0000-4000-8000-000000000002'',
  ''44000000-0000-4000-8000-000000000011'',%L::jsonb)',
  ((:'first_command')::jsonb||invalid.value)::text),'P0001','VALIDATION_FAILED',invalid.label)
from (values
  ('{"heliarQuantity":null}'::jsonb,'a blank quantity fails'),
  ('{"heliarQuantity":-1}'::jsonb,'a negative quantity fails'),
  ('{"americaQuantity":1.5}'::jsonb,'a decimal quantity fails'),
  ('{"stradaDurexQuantity":"2"}'::jsonb,'a string quantity fails'),
  ('{"stradaDurexQuantity":"invalid"}'::jsonb,'a nonnumeric quantity fails'),
  ('{"expectedVersion":"1"}'::jsonb,'a string version fails'),
  ('{"schemaVersion":2}'::jsonb,'an unsupported schema fails'),
  ('{"extra":1}'::jsonb,'unknown business fields fail')
) invalid(value,label);
select throws_ok(format('select api.save_visit_sales(''44000000-0000-4000-8000-000000000002'',
  ''44000000-0000-4000-8000-000000000011'',%L::jsonb)',
  ((:'first_command')::jsonb-'americaQuantity')::text),'P0001','VALIDATION_FAILED','a missing required quantity fails');

select jsonb_build_object('eventId','44000000-0000-4000-8000-000000000012',
  'idempotencyKey','44000000-0000-4000-8000-000000000013','operation','visit.sales.saved.v1','schemaVersion',1,
  'sequence',4,'aggregateType','visit','aggregateId','44000000-0000-4000-8000-000000000004',
  'occurredAt','2099-11-18T12:03:00Z','payload',((:'first_command')::jsonb-'schemaVersion')||
    '{"expectedVersion":1,"heliarQuantity":5,"americaQuantity":3,"stradaDurexQuantity":2,"deviceSavedAt":"2099-11-18T12:03:00Z"}') as edit_event \gset
select api.sync_event('44000000-0000-4000-8000-000000000002',(:'edit_event')::jsonb) as edit_confirmation \gset
select is(api.sync_event('44000000-0000-4000-8000-000000000002',(:'edit_event')::jsonb),
  (:'edit_confirmation')::jsonb,'event replay returns its original canonical ACK');
select is(api.save_visit_sales('44000000-0000-4000-8000-000000000002','44000000-0000-4000-8000-000000000009',
  (:'first_command')::jsonb),(:'first_sales')::jsonb,'old direct replay preserves its original version, time and zeros');
select is(api.get_visit_sales('44000000-0000-4000-8000-000000000002','44000000-0000-4000-8000-000000000004')->>'version',
  '2','old replay does not revert the latest effective version');
select throws_ok(format('select api.sync_event(''44000000-0000-4000-8000-000000000002'',%L::jsonb)',
  ((:'edit_event')::jsonb||'{"eventId":"44000000-0000-4000-8000-000000000014","idempotencyKey":"44000000-0000-4000-8000-000000000015"}')::text),
  'P0001','EVENT_OUT_OF_ORDER','a new intention with an old aggregate sequence conflicts');
select throws_ok(format('select api.sync_event(''44000000-0000-4000-8000-000000000002'',%L::jsonb)',
  ((:'edit_event')::jsonb||'{"eventId":"44000000-0000-4000-8000-000000000014","idempotencyKey":"44000000-0000-4000-8000-000000000015","sequence":5}')::text),
  'P0001','VERSION_CONFLICT','sequential events also enforce the declaration version');
select is(api.sync_event('44000000-0000-4000-8000-000000000002',(:'legacy_scrap')::jsonb),
  (:'scrap_confirmation')::jsonb,'legacy scrap replay remains unchanged after sales insertion');
reset role;
select is((select count(*)::integer from api.visit_sales_reports where visit_id=:'visit_id'),1,'edits retain one report per visit');
select is((select heliar_quantity from api.visit_sales_reports where visit_id=:'visit_id'),5,'the latest declaration remains effective');
select is((select heliar_quantity from api.stock_snapshots where visit_id=:'visit_id'),7,'declared sales never change existing inventory');
select is((select count(*)::integer from private.audit_events where target_id=:'visit_id' and action='visit.sales.saved.v1'),
  2,'only accepted new intentions create audit facts');
select ok((select before_data is not null from private.audit_events where target_id=:'visit_id'
  and action='visit.sales.saved.v1' order by occurred_at desc limit 1),'edit audit retains the previous report');
select is((select sequence from private.sync_events where event_id='44000000-0000-4000-8000-000000000007'),
  2,'legacy event sequence is never renumbered');
set local role authenticated;
select set_config('request.jwt.claim.sub',:'manager',true);
select is(api.get_visit_detail(:'visit_id','44000000-0000-4000-8000-000000000016','cli')#>>'{sections,sales,heliarQuantity}',
  '5','authorized management reads the declaration');
select is(api.get_visit_detail(:'visit_id','44000000-0000-4000-8000-000000000017','cli')#>>'{sections,sales,state}',
  'available','existing declaration is available to management');
select set_config('request.jwt.claim.sub',:'other',true);
select throws_ok($$select api.get_visit_sales('44000000-0000-4000-8000-000000000002','44000000-0000-4000-8000-000000000004')$$,
  'P0001','FORBIDDEN','another seller cannot read the declaration');
select throws_ok(format('select api.sync_event(''44000000-0000-4000-8000-000000000002'',%L::jsonb)',(:'edit_event')),
  'P0001','FORBIDDEN','another seller cannot replay the declaration');
select set_config('request.jwt.claim.sub',:'blocked',true);
select throws_ok(format('select api.sync_event(''44000000-0000-4000-8000-000000000002'',%L::jsonb)',(:'edit_event')),
  'P0001','FORBIDDEN','blocked identity cannot replay a previous declaration');
reset role;
-- Give a second seller management capability but deliberately no scope over seller A.
insert into api.user_role_assignments(user_id,role_id,assigned_by)
values(:'other','00000000-0000-4000-8000-000000000002',:'admin') on conflict do nothing;
set local role authenticated;
select set_config('request.jwt.claim.sub',:'other',true);
select throws_ok(format('select api.get_visit_detail(%L,''44000000-0000-4000-8000-000000000018'',''cli'')',:'visit_id'),
  'P0001','NOT_FOUND','manager outside scope cannot read visit sales');
reset role;
update api.user_profiles set status='inactive' where id=:'seller';
set local role authenticated;
select set_config('request.jwt.claim.sub',:'seller',true);
select throws_ok(format('select api.sync_event(''44000000-0000-4000-8000-000000000002'',%L::jsonb)',(:'edit_event')),
  'P0001','FORBIDDEN','the original seller loses replay access immediately when deactivated');
reset role;
update api.user_profiles set status='active' where id=:'seller';
set local role authenticated;
select set_config('request.jwt.claim.sub',:'seller',true);
select api.complete_visit('44000000-0000-4000-8000-000000000002','44000000-0000-4000-8000-000000000021',
  (:'checkout_command')::jsonb) as first_checkout_result \gset
select is((:'first_checkout_result')::jsonb->>'status','completed','checkout succeeds once the declaration exists');
select throws_ok(format('select api.save_visit_sales(''44000000-0000-4000-8000-000000000002'',
  ''44000000-0000-4000-8000-000000000019'',%L::jsonb)',
  ((:'first_command')::jsonb||'{"expectedVersion":2}')::text),'P0001','VERSION_CONFLICT','new writes after checkout fail');
select is(api.save_visit_sales('44000000-0000-4000-8000-000000000002','44000000-0000-4000-8000-000000000009',
  (:'first_command')::jsonb),(:'first_sales')::jsonb,'a completed visit still replays an authorized immutable confirmation');
reset role;

-- Represent a pre-feature historical visit without triggering a new completion.
insert into api.visits(id,offline_id,device_id,route_version_stop_id,route_version_id,client_id,seller_id,
  parameter_set_id,status,context_snapshot,start_payload_hash,device_started_at,server_started_at,
  device_completed_at,server_completed_at,completion_payload_hash)
select '44000000-0000-4000-8000-000000000022','44000000-0000-4000-8000-000000000023',device_id,
  route_version_stop_id,route_version_id,client_id,seller_id,parameter_set_id,'completed',context_snapshot,
  start_payload_hash,device_started_at,server_started_at,device_completed_at,server_completed_at,completion_payload_hash
from api.visits where id=:'visit_id';
select is((select status from api.visits where id='44000000-0000-4000-8000-000000000022'),
  'completed','historical completed visits remain completed');
select is((select count(*)::integer from api.visit_sales_reports where visit_id='44000000-0000-4000-8000-000000000022'),
  0,'historical visits receive no synthetic zero declarations');
set local role authenticated;
select set_config('request.jwt.claim.sub',:'manager',true);
select is(api.get_visit_detail('44000000-0000-4000-8000-000000000022','44000000-0000-4000-8000-000000000025','cli')#>>'{sections,sales,state}',
  'absent','historical management detail keeps declaration absence');
reset role;
set local role cirne_visit_executor;
select set_config('request.jwt.claim.sub',:'seller',true);
select is((select count(id)::integer from api.clients where id='44000000-0000-4000-8000-000000000001'),
  1,'checkout client read is available for the owning seller');
select is((select count(*)::integer from api.client_observed_locations where source_visit_id=:'visit_id'),
  1,'checkout stores the owning seller observed position');
select set_config('request.jwt.claim.sub',:'other',true);
select is((select count(id)::integer from api.clients where id='44000000-0000-4000-8000-000000000001'),
  0,'checkout client RLS excludes another seller');
select is((select count(*)::integer from api.client_observed_locations where source_visit_id=:'visit_id'),
  0,'observed-location RLS excludes another seller');
reset role;

-- The observed-location PK is client_id: a later authorized seller must replace
-- an earlier seller's observation through the real checkout UPSERT.
insert into api.client_seller_scopes(client_id,seller_id,assigned_by)
values('44000000-0000-4000-8000-000000000001',:'other',:'admin');
insert into api.user_seller_scopes(manager_user_id,seller_user_id)
values(:'manager',:'other');
set local role authenticated;
select set_config('request.jwt.claim.sub',:'manager',true);
select api.create_route_draft(jsonb_build_object('schemaVersion',1,'serviceDate','2099-11-19','sellerId',:'other',
  'stops',jsonb_build_array(jsonb_build_object('clientId','44000000-0000-4000-8000-000000000001',
    'plannedOrder',1,'priority',0)))) as second_seller_route \gset
select api.publish_route(((:'second_seller_route')::jsonb->>'routeId')::uuid,1);
reset role;
select id as second_seller_stop from api.route_version_stops
where route_version_id=((:'second_seller_route')::jsonb->>'routeVersionId')::uuid \gset
set local role authenticated;
select set_config('request.jwt.claim.sub',:'other',true);
select api.start_visit('44000000-0000-4000-8000-000000000040','44000000-0000-4000-8000-000000000041',
  jsonb_build_object('schemaVersion',1,'offlineId','44000000-0000-4000-8000-000000000042',
    'routeVersionStopId',:'second_seller_stop','deviceStartedAt','2099-11-19T12:00:00Z')) as second_seller_visit \gset
select api.save_visit_checkin_evidence('44000000-0000-4000-8000-000000000040','44000000-0000-4000-8000-000000000043',
  jsonb_build_object('schemaVersion',1,'offlineId','44000000-0000-4000-8000-000000000042',
    'evidence',jsonb_build_object('offlineId','44000000-0000-4000-8000-000000000044',
      'capturedAt','2099-11-19T12:00:00Z','location',jsonb_build_object('latitude','-7.116','longitude','-34.865'),
      'issues',jsonb_build_array('camera_unavailable'),'justification','Dispositivo sintetico sem camera')));
reset role;
select (:'second_seller_visit')::jsonb->>'visitId' as second_seller_visit_id \gset
insert into api.visit_commercial_action_reports(visit_id,competitor_availability,last_event_id,device_saved_at)
values(:'second_seller_visit_id','not_identified','44000000-0000-4000-8000-000000000045',now());
set local role cirne_visit_executor;
insert into api.stock_snapshots(visit_id,heliar_quantity,moura_quantity,last_event_id,device_saved_at,server_saved_at)
values(:'second_seller_visit_id',0,0,'44000000-0000-4000-8000-000000000046',now(),now());
insert into api.competitor_price_reports(visit_id,parameter_set_id,availability,last_event_id,device_saved_at,server_saved_at)
select id,parameter_set_id,'available','44000000-0000-4000-8000-000000000047',now(),now()
from api.visits where id=:'second_seller_visit_id';
select is((select count(*)::integer from api.client_observed_locations
  where client_id='44000000-0000-4000-8000-000000000001'),0,
  'a second seller cannot read the previous seller observation before checkout');
reset role;
set local role authenticated;
select api.save_visit_sales('44000000-0000-4000-8000-000000000040','44000000-0000-4000-8000-000000000048',
  ((:'first_command')::jsonb||'{"offlineId":"44000000-0000-4000-8000-000000000042","deviceSavedAt":"2099-11-19T12:01:00Z"}'));
select api.sync_event('44000000-0000-4000-8000-000000000040',
  ((:'legacy_scrap')::jsonb||jsonb_build_object('eventId','44000000-0000-4000-8000-000000000049',
    'idempotencyKey','44000000-0000-4000-8000-000000000050','sequence',3,
    'aggregateId','44000000-0000-4000-8000-000000000042','occurredAt','2099-11-19T12:02:00Z',
    'payload',((:'legacy_scrap')::jsonb->'payload')||
      '{"offlineId":"44000000-0000-4000-8000-000000000042","deviceSavedAt":"2099-11-19T12:02:00Z"}')));
select jsonb_build_object('schemaVersion',1,'offlineId','44000000-0000-4000-8000-000000000042',
  'deviceCompletedAt','2099-11-19T12:05:00Z','evidence',jsonb_build_object(
    'offlineId','44000000-0000-4000-8000-000000000051','capturedAt','2099-11-19T12:05:00Z',
    'location',jsonb_build_object('latitude','-7.116','longitude','-34.865'),
    'issues',jsonb_build_array('camera_unavailable'),'justification','Dispositivo sintetico sem camera')) as second_checkout \gset
select is(api.complete_visit('44000000-0000-4000-8000-000000000040','44000000-0000-4000-8000-000000000052',
  (:'second_checkout')::jsonb)->>'status','completed',
  'a second authorized seller can checkout the same client after the first seller');
select is(nullif(current_setting('cirne.checkout_source_visit_id',true),''),null::text,
  'successful checkout clears its temporary observation context');
reset role;
set local role cirne_visit_executor;
select is((select source_visit_id::text from api.client_observed_locations
  where client_id='44000000-0000-4000-8000-000000000001'),:'second_seller_visit_id',
  'the same client observation is replaced by the second seller current visit');
select to_jsonb(observation) as second_seller_observation from api.client_observed_locations observation
where client_id='44000000-0000-4000-8000-000000000001' \gset
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub',:'seller',true);
select is(api.complete_visit('44000000-0000-4000-8000-000000000002','44000000-0000-4000-8000-000000000021',
  (:'checkout_command')::jsonb),(:'first_checkout_result')::jsonb,
  'old checkout replay returns the original complete canonical result');
select is(nullif(current_setting('cirne.checkout_source_visit_id',true),''),null::text,
  'old checkout replay does not leave an observation write context');
select throws_ok(format('select api.complete_visit(''44000000-0000-4000-8000-000000000002'',
  ''44000000-0000-4000-8000-000000000021'',%L::jsonb)',
  ((:'checkout_command')::jsonb||'{"deviceCompletedAt":"2099-11-18T12:06:00Z"}')::text),
  'P0001','IDEMPOTENCY_KEY_REUSED','old checkout replay still rejects a divergent complete payload');
select set_config('request.jwt.claim.sub',:'other',true);
select throws_ok(format('select api.complete_visit(''44000000-0000-4000-8000-000000000002'',
  ''44000000-0000-4000-8000-000000000021'',%L::jsonb)',(:'checkout_command')),
  'P0001','FORBIDDEN','another seller cannot replay the first seller checkout');
reset role;
update api.user_profiles set status='inactive' where id=:'seller';
set local role authenticated;
select set_config('request.jwt.claim.sub',:'seller',true);
select throws_ok(format('select api.complete_visit(''44000000-0000-4000-8000-000000000002'',
  ''44000000-0000-4000-8000-000000000021'',%L::jsonb)',(:'checkout_command')),
  'P0001','FORBIDDEN','an inactive original seller cannot replay its completed checkout');
reset role;
update api.user_profiles set status='active' where id=:'seller';
select ok((select count(*)=1 from private.audit_events where target_id=:'visit_id' and action='visit.completed.v1')
  and (select count(*)=1 from api.location_events where visit_id=:'visit_id' and kind='completion'),
  'old checkout replay creates no new completion audit or location facts');
set local role cirne_visit_executor;
select set_config('request.jwt.claim.sub',:'other',true);
select is((select to_jsonb(observation) from api.client_observed_locations observation
  where client_id='44000000-0000-4000-8000-000000000001'),(:'second_seller_observation')::jsonb,
  'replay of checkout A preserves the complete newer observation from B');
select throws_ok(format('update api.client_observed_locations set source_visit_id=%L
  where client_id=''44000000-0000-4000-8000-000000000001''',:'visit_id'),
  '42501',null,'a seller cannot repoint an observation to another seller visit');
reset role;
select id as unrelated_seller from auth.users where raw_user_meta_data->>'actorKey'='seller_e2e' \gset
set local role cirne_visit_executor;
select set_config('request.jwt.claim.sub',:'unrelated_seller',true);
select set_config('cirne.checkout_source_visit_id',:'second_seller_visit_id',true);
select is((select count(*)::integer from api.client_observed_locations
  where client_id='44000000-0000-4000-8000-000000000001'),0,
  'an unrelated seller cannot read the shared client observation');
select throws_ok(format('insert into api.client_observed_locations(client_id,source_visit_id,checkin_position,
  checkout_position,observed_position,observed_at) values(''44000000-0000-4000-8000-000000000001'',%L,
  extensions.st_setsrid(extensions.st_makepoint(-34.865,-7.116),4326)::extensions.geography,
  extensions.st_setsrid(extensions.st_makepoint(-34.865,-7.116),4326)::extensions.geography,
  extensions.st_setsrid(extensions.st_makepoint(-34.865,-7.116),4326)::extensions.geography,now())
  on conflict(client_id) do update set source_visit_id=excluded.source_visit_id,
    observed_position=excluded.observed_position',:'second_seller_visit_id'),
  '42501',null,'an unrelated seller cannot upsert another seller observation');
select set_config('cirne.checkout_source_visit_id','',true);
reset role;
set local role authenticated;
select throws_ok(format('select api.complete_visit(''44000000-0000-4000-8000-000000000040'',
  ''44000000-0000-4000-8000-000000000053'',%L::jsonb)',(:'second_checkout')),
  'P0001','FORBIDDEN','an unrelated seller cannot establish another seller checkout context');
reset role;

select * from finish();
rollback;
