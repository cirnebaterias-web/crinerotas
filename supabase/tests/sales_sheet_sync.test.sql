-- Synthetic fixtures only; this entire suite rolls back.
begin;
select no_plan();
select has_table('private','sales_sources','source configuration is private');
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid='private.sales_sources'::regclass),'source forces RLS');
select ok(not has_table_privilege('authenticated','private.sales_snapshot_lines','SELECT,INSERT,UPDATE,DELETE'),'browser cannot access snapshots directly');
select ok(not has_table_privilege('service_role','private.sales_sources','SELECT,INSERT,UPDATE,DELETE'),'service role cannot configure sources');
select ok(not has_function_privilege('anon','api.begin_sales_sheet_sync(text,text,text)','EXECUTE'),'anonymous cannot begin');
select ok(not has_function_privilege('authenticated','private.sales_client_context(uuid,uuid)','EXECUTE'),'private context is not callable');
select ok(not has_function_privilege('service_role','private.sales_source_identity(text)','EXECUTE'),'source authority helper is not callable');
select ok(not has_column_privilege('cirne_route_executor','private.sales_sources','scheduler_actor_id','UPDATE'),'executor cannot change technical actor');
select ok(has_column_privilege('cirne_route_executor','private.sales_sources','published_run_id','UPDATE'),'executor can publish only head columns');
select ok(not exists(select 1 from api.role_permissions p join api.roles r on r.id=p.role_id where r.code='administrator' and p.permission_code='sales.read_client'),'administrator has no implicit commercial read');

select id as manager from auth.users where raw_user_meta_data->>'actorKey'='manager_a' order by created_at desc,id limit 1 \gset
select id as other_manager from auth.users where raw_user_meta_data->>'actorKey'='manager_e2e' order by created_at desc,id limit 1 \gset
select id as administrator from auth.users where raw_user_meta_data->>'actorKey'='administrator' order by created_at desc,id limit 1 \gset
select id as seller from auth.users where raw_user_meta_data->>'actorKey'='seller_a'
  and id in(select seller_user_id from api.user_seller_scopes where manager_user_id=:'manager' and revoked_at is null)
  order by created_at desc,id limit 1 \gset
insert into api.clients(id,external_reference,name,address) values
 ('41300000-0000-4000-8000-000000000001','41300000000001','Cliente vendas TESTE','Endereco sintetico'),
 ('41300000-0000-4000-8000-000000000002','41300000000002','Cliente fora TESTE','Endereco sintetico');
insert into api.client_seller_scopes(client_id,seller_id,assigned_by)
 values('41300000-0000-4000-8000-000000000001',:'seller',:'manager');

set local role authenticated;
select set_config('request.jwt.claim.sub',:'manager',true);
select throws_ok($$select api.begin_sales_sheet_sync(repeat('4',64),'41300000-0000-4000-8000-000000000001')$$,'P0001','FORBIDDEN','missing binding denies manual source access');
select throws_ok($$select api.begin_sales_sheet_sync(repeat('4',64),'2000-01-01@06:15','scheduled')$$,'P0001','FORBIDDEN','binding is checked before clock');
select throws_ok($$select api.get_client_sales_page('41300000-0000-4000-8000-000000000001')$$,'P0001','SALES_UNAVAILABLE','missing generation is explicitly unavailable, not fake zero');
reset role;
insert into private.sales_sources(source_key,scheduler_actor_id) values(repeat('4',64),:'manager');
select throws_ok(format('insert into private.sales_sources(source_key,scheduler_actor_id) values(%L,%L)',repeat('5',64),:'manager'),'23505',null,'singleton prevents ambiguous CRM source');

do $membership$
begin execute format('grant cirne_route_executor to %I with inherit true,set true granted by current_user',current_user); end
$membership$;
create function pg_temp.sales_hash(rows jsonb) returns text language sql security definer as $$
  select encode(extensions.digest(convert_to(string_agg(private.sales_row_hash(value),'' order by (value->>'sourceRow')::integer),'UTF8'),'sha256'),'hex')
  from jsonb_array_elements(rows);
$$;
select jsonb_build_object('sourceRow',2,'externalKey','SYNTHETIC-A','clientExternalReference','41300000000001','invoiceNumber','00001',
 'saleDate','2026-10-01','sku','000SKU','productDescription','Bateria sintetica','itemGroup','SLI','itemSubgroup','',
 'category','Leve','brand','TESTE','line','','kind','sale','volume',3,'totalAmount','123.45') as row_a \gset
select (:'row_a')::jsonb||jsonb_build_object('sourceRow',3,'externalKey','SYNTHETIC-B','saleDate','2026-10-02','kind','return','volume',-1,'totalAmount','-41.15') as row_b \gset
select (:'row_a')::jsonb||jsonb_build_object('sourceRow',4,'externalKey','SYNTHETIC-C','clientExternalReference','41300000000999','sku','UNMATCHED-SKU') as row_c \gset
select jsonb_build_array((:'row_a')::jsonb,(:'row_b')::jsonb,(:'row_c')::jsonb) as rows \gset
select pg_temp.sales_hash((:'rows')::jsonb) as content_hash \gset
select is(private.sales_row_hash((:'row_a')::jsonb),'a9c2867765f29477bdbf7baf34df66ea4f0a67cc438565a3e335d63081c94513','known Node JSON.stringify tuple hash matches SQL');
select is(private.sales_row_hash((:'row_a')::jsonb||jsonb_build_object('productDescription',
 'Bateria '||chr(199)||'af'||chr(233)||' "'||chr(937)||'" \ / '||chr(20320)||chr(22909))),
 'a9b319995a4f8fbf9a4f61cb4e2056982605c939ac55b1b8353011f0e3f2f78a','Unicode, quotes and backslash hash exactly as Node');
select throws_ok(format('select private.sales_row_hash(%L::jsonb)',(:'row_a')::jsonb||'{"cost":1}'::jsonb),'P0001','VALIDATION_FAILED','extra costs/raw fields rejected');
select throws_ok(format('select private.sales_row_hash(%L::jsonb)',(:'row_a')::jsonb||'{"saleDate":"2026-02-30"}'::jsonb),'P0001','VALIDATION_FAILED','impossible date rejected');
select throws_ok(format('select private.sales_row_hash(%L::jsonb)',(:'row_a')::jsonb||'{"saleDate":"1899-12-31"}'::jsonb),'P0001','VALIDATION_FAILED','date lower bound matches normalizer');
select throws_ok(format('select private.sales_row_hash(%L::jsonb)',(:'row_a')::jsonb||'{"totalAmount":"-0.00"}'::jsonb),'P0001','VALIDATION_FAILED','noncanonical negative zero rejected');
select throws_ok(format('select private.sales_row_hash(%L::jsonb)',(:'row_a')::jsonb||'{"volume":-1}'::jsonb),'P0001','VALIDATION_FAILED','wrong sale sign rejected');
select throws_ok(format('select private.sales_row_hash(%L::jsonb)',(:'row_a')::jsonb||jsonb_build_object('productDescription',E'bad\ncell')),'P0001','VALIDATION_FAILED','control characters rejected');

set local role authenticated;
select set_config('request.jwt.claim.sub',:'administrator',true);
select throws_ok($$select api.begin_sales_sheet_sync(repeat('4',64),'41300000-0000-4000-8000-000000000001')$$,'P0001','FORBIDDEN','admin cannot bypass source binding');
select throws_ok($$select api.get_client_sales_page('41300000-0000-4000-8000-000000000001')$$,'P0001','FORBIDDEN','admin cannot read commercial data by default');
select set_config('request.jwt.claim.sub',:'seller',true);
select throws_ok($$select api.begin_sales_sheet_sync(repeat('4',64),'41300000-0000-4000-8000-000000000001')$$,'P0001','FORBIDDEN','seller cannot import');
select throws_ok($$select api.fail_sales_sheet_sync('41300000-0000-4000-8000-000000000099','41300000-0000-4000-8000-000000000099','INTERRUPTED')$$,'P0001','FORBIDDEN','capability checked before nonexistent run lookup');
select set_config('request.jwt.claim.sub',:'manager',true);
select is(api.get_sales_sheet_sync_status(repeat('4',64)),jsonb_build_object('latestRun',null,'lastPublishedRun',null),'configured empty status has explicit nulls');
select throws_ok($$select api.begin_sales_sheet_sync(repeat('4',64),'2000-01-01@06:15','scheduled')$$,'P0001','VALIDATION_FAILED','new scheduled slot validates server date/window');
select api.begin_sales_sheet_sync(repeat('4',64),'41300000-0000-4000-8000-000000000001') as begun \gset
select is((:'begun')::jsonb->>'replayed','false','new intent acquires lease');
select is((:'begun')::jsonb->'result'->>'status','collecting','collecting visible to importer only');
select is(api.begin_sales_sheet_sync(repeat('4',64),'41300000-0000-4000-8000-000000000001')->>'leaseToken',(:'begun')::jsonb->>'leaseToken','same authorized intent recovers lost begin lease');
select throws_ok($$select api.begin_sales_sheet_sync(repeat('4',64),'41300000-0000-4000-8000-000000000002')$$,'P0001','SYNC_BUSY','another intention cannot run simultaneously');
select throws_ok(format('select api.stage_sales_sheet_sync(%L,%L,0,%L,%L)',(:'begun')::jsonb->>'runId','41300000-0000-4000-8000-000000000099',:'content_hash',:'rows'),'P0001','NOT_FOUND','wrong lease cannot stage');
select throws_ok(format('select api.stage_sales_sheet_sync(%L,%L,0,%L,%L)',(:'begun')::jsonb->>'runId',(:'begun')::jsonb->>'leaseToken',repeat('0',64),:'rows'),'P0001','VERSION_CONFLICT','chunk hash recomputed, not trusted');
select api.stage_sales_sheet_sync(((:'begun')::jsonb->>'runId')::uuid,((:'begun')::jsonb->>'leaseToken')::uuid,0,:'content_hash',(:'rows')::jsonb) as staged \gset
select is((:'staged')::jsonb->>'stagedCount','3','all validated rows staged');
select is(api.stage_sales_sheet_sync(((:'begun')::jsonb->>'runId')::uuid,((:'begun')::jsonb->>'leaseToken')::uuid,0,:'content_hash',(:'rows')::jsonb)->>'replayed','true','lost stage response safely replays');
select throws_ok(format('select api.stage_sales_sheet_sync(%L,%L,0,%L,%L)',(:'begun')::jsonb->>'runId',(:'begun')::jsonb->>'leaseToken',
 pg_temp.sales_hash(jsonb_build_array((:'row_a')::jsonb)),jsonb_build_array((:'row_a')::jsonb)),
 'P0001','VERSION_CONFLICT','same chunk intent with different valid content conflicts');
select throws_ok(format('select api.stage_sales_sheet_sync(%L,%L,1,%L,%L)',(:'begun')::jsonb->>'runId',(:'begun')::jsonb->>'leaseToken',
 pg_temp.sales_hash(jsonb_build_array((:'row_a')::jsonb||'{"sourceRow":5}'::jsonb)),jsonb_build_array((:'row_a')::jsonb||'{"sourceRow":5}'::jsonb)),
 'P0001','VALIDATION_FAILED','duplicate external key across chunks fails instead of merging');
select throws_ok($$select api.get_client_sales_page('41300000-0000-4000-8000-000000000001')$$,'P0001','SALES_UNAVAILABLE','staging never visible to CRM');
select throws_ok(format('select api.publish_sales_sheet_sync(%L,%L,%L,0,1)',(:'begun')::jsonb->>'runId',(:'begun')::jsonb->>'leaseToken',:'content_hash'),'P0001','VALIDATION_FAILED','empty publication forbidden');
select throws_ok(format('select api.publish_sales_sheet_sync(%L,%L,%L,2,1)',(:'begun')::jsonb->>'runId',(:'begun')::jsonb->>'leaseToken',:'content_hash'),'P0001','VERSION_CONFLICT','partial count cannot publish');
select api.publish_sales_sheet_sync(((:'begun')::jsonb->>'runId')::uuid,((:'begun')::jsonb->>'leaseToken')::uuid,:'content_hash',3,1) as published \gset
select is((:'published')::jsonb->>'status','published','whole generation publishes');
select is((:'published')::jsonb->>'sourceRowCount','3','complete source count persisted');
select is((:'published')::jsonb->>'unmatchedClientCount','1','unmatched document counted without auto-creation');
select is((:'published')::jsonb->>'issueCount','1','private row issue counted');
select is(api.publish_sales_sheet_sync(((:'begun')::jsonb->>'runId')::uuid,((:'begun')::jsonb->>'leaseToken')::uuid,:'content_hash',3,1),(:'published')::jsonb,'lost publication response replays canonical result');
select is(api.fail_sales_sheet_sync(((:'begun')::jsonb->>'runId')::uuid,((:'begun')::jsonb->>'leaseToken')::uuid,'INTERRUPTED'),(:'published')::jsonb,'late failure cannot overwrite success');
select throws_ok(format('select api.publish_sales_sheet_sync(%L,%L,%L,3,1)',(:'begun')::jsonb->>'runId',(:'begun')::jsonb->>'leaseToken',repeat('0',64)),'P0001','VERSION_CONFLICT','terminal replay rejects changed hash');
select set_config('request.jwt.claim.sub',:'other_manager',true);
select throws_ok($$select api.begin_sales_sheet_sync(repeat('4',64),'41300000-0000-4000-8000-000000000001')$$,'P0001','FORBIDDEN','known intent cannot replay by another manager');
select throws_ok($$select api.get_sales_sheet_sync_status(repeat('4',64))$$,'P0001','FORBIDDEN','status binding remains private');
select throws_ok($$select api.get_client_sales_page('41300000-0000-4000-8000-000000000001')$$,'P0001','NOT_FOUND','out-of-scope manager cannot read client');
select set_config('request.jwt.claim.sub',:'seller',true);
select api.get_client_sales_page('41300000-0000-4000-8000-000000000001') as client_page \gset
select is(jsonb_array_length((:'client_page')::jsonb->'rows'),2,'seller sees only its client facts');
select is((:'client_page')::jsonb->'rows'->1->>'volume','-1','return volume stays negative');
select is((:'client_page')::jsonb->'rows'->1->>'totalAmount','-41.15','exact money stays signed decimal string');
select ok(not ((:'client_page')::jsonb ?| array['reference','sourceKey','clientExternalReference','externalKey']),'client page has no private linkage keys');
select is((:'client_page')::jsonb->'rows'->0->>'invoiceNumber','00001','invoice leading zeros preserved');
select is(jsonb_array_length(api.get_client_sales_products('41300000-0000-4000-8000-000000000001',((:'published')::jsonb->>'id')::uuid)->'products'),2,'catalog contains safe descriptors from whole snapshot');
select throws_ok($$select api.get_client_sales_page('41300000-0000-4000-8000-000000000002')$$,'P0001','NOT_FOUND','seller cannot select unassigned client');
reset role;
select is((select count(*)::integer from private.audit_events where target_id=((:'published')::jsonb->>'id')::uuid and action='sales.published'),1,'one publication creates one audit event');
select is((select count(*)::integer from api.clients where external_reference='41300000000999'),0,'unmatched sales never create customers');
set local role cirne_route_executor;
select throws_ok($$update private.sales_sources set scheduler_actor_id=gen_random_uuid()$$,'42501',null,'executor cannot rebind source');
select throws_ok($$insert into private.sales_sources(source_key,scheduler_actor_id) values(repeat('5',64),gen_random_uuid())$$,'42501',null,'executor cannot provision source');
with changed as (delete from private.sales_snapshot_lines returning 1)
select is((select count(*)::integer from changed),0,'immutable rows have no delete policy');
reset role;

-- Corrections and removals publish a new immutable generation, never mix generations.
select jsonb_build_array((:'row_a')::jsonb||jsonb_build_object('volume',7,'totalAmount','287.00')) as corrected_rows \gset
select pg_temp.sales_hash((:'corrected_rows')::jsonb) as corrected_hash \gset
set local role authenticated;
select set_config('request.jwt.claim.sub',:'manager',true);
select api.begin_sales_sheet_sync(repeat('4',64),'41300000-0000-4000-8000-000000000002') as second_run \gset
select api.stage_sales_sheet_sync(((:'second_run')::jsonb->>'runId')::uuid,((:'second_run')::jsonb->>'leaseToken')::uuid,0,:'corrected_hash',(:'corrected_rows')::jsonb);
select api.publish_sales_sheet_sync(((:'second_run')::jsonb->>'runId')::uuid,((:'second_run')::jsonb->>'leaseToken')::uuid,:'corrected_hash',1,1) as second_published \gset
select throws_ok(format('select api.get_client_sales_page(%L,%L)', '41300000-0000-4000-8000-000000000001',(:'published')::jsonb->>'id'),'P0001','VERSION_CONFLICT','old generation cursor cannot mix with new generation');
select is(jsonb_array_length(api.get_client_sales_page('41300000-0000-4000-8000-000000000001')->'rows'),1,'source removal applies only to current snapshot');
select is(api.get_client_sales_page('41300000-0000-4000-8000-000000000001')->'rows'->0->>'volume','7','source correction replaces current value');
reset role;
select is((select count(*)::integer from private.sales_snapshot_lines where run_id=((:'published')::jsonb->>'id')::uuid),3,'previous immutable generation preserved');
update api.clients set status='inactive',archived_at=now() where id='41300000-0000-4000-8000-000000000001';
set local role authenticated;
select set_config('request.jwt.claim.sub',:'seller',true);
select lives_ok($$select api.get_client_sales_page('41300000-0000-4000-8000-000000000001')$$,'inactive client remains readable under current scope');
reset role;
update api.client_seller_scopes set revoked_at=now() where client_id='41300000-0000-4000-8000-000000000001';
set local role authenticated;
select throws_ok($$select api.get_client_sales_page('41300000-0000-4000-8000-000000000001')$$,'P0001','NOT_FOUND','revoked current scope denies previously visible history');
reset role;
update api.client_seller_scopes set revoked_at=null where client_id='41300000-0000-4000-8000-000000000001';
update api.clients set external_reference='41300000000888' where id='41300000-0000-4000-8000-000000000001';
set local role authenticated;
select is(jsonb_array_length(api.get_client_sales_page('41300000-0000-4000-8000-000000000001')->'rows'),0,'current document change never grants historical wrong identity');
reset role;
update api.clients set external_reference='41300000000001' where id='41300000-0000-4000-8000-000000000001';
update api.user_profiles set status='inactive',blocked_at=now() where id=:'seller';
set local role authenticated;
select throws_ok($$select api.get_client_sales_page('41300000-0000-4000-8000-000000000001')$$,'P0001','FORBIDDEN','blocked seller denied despite old JWT');
reset role;
update api.user_profiles set status='active',blocked_at=null where id=:'seller';

-- Revocation after acquisition prevents mutation and keeps published head intact.
set local role authenticated;
select set_config('request.jwt.claim.sub',:'manager',true);
select api.begin_sales_sheet_sync(repeat('4',64),'41300000-0000-4000-8000-000000000003') as revoked_run \gset
reset role;
update private.sales_sources set scheduler_actor_id=null;
set local role authenticated;
select throws_ok($$select api.begin_sales_sheet_sync(repeat('4',64),'41300000-0000-4000-8000-000000000003')$$,'P0001','FORBIDDEN','NULL binding revokes even same-intent replay');
select throws_ok(format('select api.publish_sales_sheet_sync(%L,%L,%L,3,1)',(:'revoked_run')::jsonb->>'runId',(:'revoked_run')::jsonb->>'leaseToken',:'content_hash'),'P0001','FORBIDDEN','NULL binding denies publication');
select throws_ok($$select api.get_sales_sheet_sync_status(repeat('4',64))$$,'P0001','FORBIDDEN','NULL binding denies importer status');
select lives_ok($$select api.get_client_sales_page('41300000-0000-4000-8000-000000000001')$$,'revoking importer does not revoke authorized published CRM');
reset role;
update private.sales_sources set scheduler_actor_id=:'other_manager';
set local role authenticated;
select throws_ok(format('select api.stage_sales_sheet_sync(%L,%L,0,%L,%L)',(:'revoked_run')::jsonb->>'runId',(:'revoked_run')::jsonb->>'leaseToken',:'content_hash',:'rows'),'P0001','FORBIDDEN','reassigned source denies old actor before staging');
select throws_ok(format('select api.publish_sales_sheet_sync(%L,%L,%L,3,1)',(:'revoked_run')::jsonb->>'runId',(:'revoked_run')::jsonb->>'leaseToken',:'content_hash'),'P0001','FORBIDDEN','reassigned source denies old actor publication');
reset role;
update private.sales_sources set scheduler_actor_id=:'manager';
set local role cirne_route_executor;
update private.sales_sync_runs set lease_expires_at=clock_timestamp()-interval '1 second' where id=((:'revoked_run')::jsonb->>'runId')::uuid;
reset role;
set local role authenticated;
select throws_ok(format('select api.publish_sales_sheet_sync(%L,%L,%L,3,1)',(:'revoked_run')::jsonb->>'runId',(:'revoked_run')::jsonb->>'leaseToken',:'content_hash'),'P0001','SYNC_LEASE_EXPIRED','expired executor cannot publish');
select is(api.get_sales_sheet_sync_status(repeat('4',64))->'lastPublishedRun',(:'second_published')::jsonb,'failed/expired latest attempt keeps last successful generation');
select api.begin_sales_sheet_sync(repeat('4',64),'41300000-0000-4000-8000-000000000004') as successor \gset
select is((:'successor')::jsonb->'result'->>'status','collecting','expired lease can be succeeded');
select api.fail_sales_sheet_sync(((:'successor')::jsonb->>'runId')::uuid,((:'successor')::jsonb->>'leaseToken')::uuid,'SOURCE_CHANGED');
select is(api.begin_sales_sheet_sync(repeat('4',64),'41300000-0000-4000-8000-000000000004')->'result'->>'status','failed','failed intent is terminal, not silently retried');
select is(api.begin_sales_sheet_sync(repeat('4',64),'41300000-0000-4000-8000-000000000003')->>'leaseToken',null::text,'expired intent never regains lease');
reset role;

-- Losing current capability or becoming blocked invalidates an acquired lease.
set local role authenticated;
select api.begin_sales_sheet_sync(repeat('4',64),'41300000-0000-4000-8000-000000000005') as permission_run \gset
reset role;
update api.user_profiles set status='inactive',blocked_at=now() where id=:'manager';
set local role authenticated;
select throws_ok(format('select api.publish_sales_sheet_sync(%L,%L,%L,3,1)',(:'permission_run')::jsonb->>'runId',(:'permission_run')::jsonb->>'leaseToken',:'content_hash'),'P0001','FORBIDDEN','blocked importer cannot publish old lease');
select throws_ok($$select api.get_sales_sheet_sync_status(repeat('4',64))$$,'P0001','FORBIDDEN','blocked importer cannot read status');
reset role;
update api.user_profiles set status='active',blocked_at=null where id=:'manager';
delete from api.role_permissions p using api.roles r where p.role_id=r.id and r.code='manager' and p.permission_code='sales.sync';
set local role authenticated;
select throws_ok(format('select api.stage_sales_sheet_sync(%L,%L,0,%L,%L)',(:'permission_run')::jsonb->>'runId',(:'permission_run')::jsonb->>'leaseToken',:'content_hash',:'rows'),'P0001','FORBIDDEN','revoked import capability prevents staging');
select throws_ok(format('select api.publish_sales_sheet_sync(%L,%L,%L,3,1)',(:'permission_run')::jsonb->>'runId',(:'permission_run')::jsonb->>'leaseToken',:'content_hash'),'P0001','FORBIDDEN','revoked import capability prevents publication');
reset role;
insert into api.role_permissions(role_id,permission_code) select id,'sales.sync' from api.roles where code='manager';
set local role authenticated;
select api.fail_sales_sheet_sync(((:'permission_run')::jsonb->>'runId')::uuid,((:'permission_run')::jsonb->>'leaseToken')::uuid,'INTERRUPTED');
reset role;

-- At least the observed source order of magnitude, through the real stage RPC.
create temporary table sales_load_rows(source_row integer primary key,document jsonb not null,row_hash text not null);
insert into sales_load_rows
select n,document,private.sales_row_hash(document) from generate_series(2,26001) n
cross join lateral(select (:'row_a')::jsonb||jsonb_build_object('sourceRow',n,'externalKey','LOAD-'||n,
 'sku','SKU-'||lpad(((n-2)%135)::text,3,'0')) as document) d;
select encode(extensions.digest(convert_to(string_agg(row_hash,'' order by source_row),'UTF8'),'sha256'),'hex') as load_hash from sales_load_rows \gset
grant select on sales_load_rows to authenticated;
set local role authenticated;
select api.begin_sales_sheet_sync(repeat('4',64),'41300000-0000-4000-8000-000000000006') as load_run \gset
select set_config('test.sales_run',:'load_run',true);
do $load$
declare chunk_index integer; rows jsonb; chunk_hash text; run jsonb:=current_setting('test.sales_run')::jsonb;
begin
 for chunk_index in 0..25 loop
  select jsonb_agg(document order by source_row),encode(extensions.digest(convert_to(string_agg(row_hash,'' order by source_row),'UTF8'),'sha256'),'hex')
  into rows,chunk_hash from sales_load_rows where source_row between 2+chunk_index*1000 and 1001+chunk_index*1000;
  perform api.stage_sales_sheet_sync((run->>'runId')::uuid,(run->>'leaseToken')::uuid,chunk_index,chunk_hash,rows);
 end loop;
end
$load$;
select is(api.get_sales_sheet_sync_status(repeat('4',64))->'latestRun'->>'stagedRowCount','26000','26k source fully staged without old 5k limit');
select api.publish_sales_sheet_sync(((:'load_run')::jsonb->>'runId')::uuid,((:'load_run')::jsonb->>'leaseToken')::uuid,:'load_hash',26000,1) as load_published \gset
select is((:'load_published')::jsonb->>'sourceRowCount','26000','26k verified rows published atomically');
select is(jsonb_array_length(api.get_client_sales_page('41300000-0000-4000-8000-000000000001')->'rows'),1000,'first page is bounded to 1000 rows');
select is(api.get_client_sales_page('41300000-0000-4000-8000-000000000001')->>'nextAfterRow','1001','cursor is original source row, not document-bearing key');
select is(jsonb_array_length(api.get_client_sales_page('41300000-0000-4000-8000-000000000001',((:'load_published')::jsonb->>'id')::uuid,25001)->'rows'),1000,'final complete page is not truncated');
select is(api.get_client_sales_page('41300000-0000-4000-8000-000000000001',((:'load_published')::jsonb->>'id')::uuid,25001)->>'nextAfterRow',null::text,'final page signals completion');
select is(jsonb_array_length(api.get_client_sales_products('41300000-0000-4000-8000-000000000001',((:'load_published')::jsonb->>'id')::uuid)->'products'),135,'derived catalog is distinct across 26k facts');
reset role;
select is((select count(*)::integer from private.sales_snapshot_lines where run_id=((:'load_published')::jsonb->>'id')::uuid),26000,'stored row count agrees with publication');

-- Positive scheduled replay is recoverable outside its acquisition window.
insert into private.sales_sync_runs(source_key,request_key,trigger,requested_by,lease_expires_at)
 values(repeat('4',64),'2000-01-01@06:15','scheduled',:'manager',clock_timestamp()+interval '10 minutes') returning id as scheduled_run \gset
set local role authenticated;
select set_config('request.jwt.claim.sub',:'other_manager',true);
select throws_ok($$select api.begin_sales_sheet_sync(repeat('4',64),'2000-01-01@06:15','scheduled')$$,'P0001','FORBIDDEN','other manager cannot replay existing scheduled slot');
select set_config('request.jwt.claim.sub',:'manager',true);
select api.begin_sales_sheet_sync(repeat('4',64),'2000-01-01@06:15','scheduled') as scheduled_replay \gset
select is((:'scheduled_replay')::jsonb->>'runId',:'scheduled_run','bound scheduled replay returns original intent outside window');
select ok((:'scheduled_replay')::jsonb->>'leaseToken' is not null,'bound scheduled replay recovers unexpired lease');
select api.fail_sales_sheet_sync(((:'scheduled_replay')::jsonb->>'runId')::uuid,((:'scheduled_replay')::jsonb->>'leaseToken')::uuid,'INTERRUPTED');
reset role;

-- Catalog pagination is deterministic and future-only SKUs are not opportunities.
create temporary table sales_catalog_rows as
 select n as source_row,document,private.sales_row_hash(document) as row_hash from generate_series(2,1003) n
 cross join lateral(select (:'row_a')::jsonb||jsonb_build_object('sourceRow',n,'externalKey','CATALOG-'||n,
  'sku','CATALOG-'||lpad(n::text,4,'0'),'saleDate',case when n=1003 then '9999-01-01' else '2026-01-01' end) as document) d;
select encode(extensions.digest(convert_to(string_agg(row_hash,'' order by source_row),'UTF8'),'sha256'),'hex') as catalog_hash from sales_catalog_rows \gset
grant select on sales_catalog_rows to authenticated;
set local role authenticated;
select api.begin_sales_sheet_sync(repeat('4',64),'41300000-0000-4000-8000-000000000007') as catalog_run \gset
select api.stage_sales_sheet_sync(((:'catalog_run')::jsonb->>'runId')::uuid,((:'catalog_run')::jsonb->>'leaseToken')::uuid,0,
 (select encode(extensions.digest(convert_to(string_agg(row_hash,'' order by source_row),'UTF8'),'sha256'),'hex') from sales_catalog_rows where source_row<=1001),
 (select jsonb_agg(document order by source_row) from sales_catalog_rows where source_row<=1001));
select api.stage_sales_sheet_sync(((:'catalog_run')::jsonb->>'runId')::uuid,((:'catalog_run')::jsonb->>'leaseToken')::uuid,1,
 (select encode(extensions.digest(convert_to(string_agg(row_hash,'' order by source_row),'UTF8'),'sha256'),'hex') from sales_catalog_rows where source_row>1001),
 (select jsonb_agg(document order by source_row) from sales_catalog_rows where source_row>1001));
select api.publish_sales_sheet_sync(((:'catalog_run')::jsonb->>'runId')::uuid,((:'catalog_run')::jsonb->>'leaseToken')::uuid,:'catalog_hash',1002,1) as catalog_published \gset
select api.get_client_sales_products('41300000-0000-4000-8000-000000000001',((:'catalog_published')::jsonb->>'id')::uuid) as catalog_page \gset
select is(jsonb_array_length((:'catalog_page')::jsonb->'products'),1000,'catalog page limit enforced');
select is((:'catalog_page')::jsonb->>'nextAfterSku','CATALOG-1001','catalog cursor stable in C collation');
select api.get_client_sales_products('41300000-0000-4000-8000-000000000001',((:'catalog_published')::jsonb->>'id')::uuid,(:'catalog_page')::jsonb->>'nextAfterSku') as catalog_last \gset
select is(jsonb_array_length((:'catalog_last')::jsonb->'products'),1,'catalog final page excludes future-only SKU');
select is((:'catalog_last')::jsonb->>'nextAfterSku',null::text,'catalog final page completion explicit');
select throws_ok(format('select api.get_client_sales_products(%L,%L)','41300000-0000-4000-8000-000000000002',(:'catalog_published')::jsonb->>'id'),'P0001','NOT_FOUND','catalog still requires current authorized client');
reset role;

do $membership$
begin execute format('revoke cirne_route_executor from %I granted by current_user',current_user); end
$membership$;
select * from finish();
rollback;
