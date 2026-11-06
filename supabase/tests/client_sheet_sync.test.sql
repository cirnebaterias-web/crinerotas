begin;
select no_plan();

select has_table('private','client_sheet_sync_runs','sync runs are durable and private');
select ok(not has_table_privilege('authenticated','private.client_sheet_sync_runs','SELECT'),
  'browser cannot read run rows directly');
select ok(not has_function_privilege('anon','api.begin_client_sheet_sync(text,text,text)','EXECUTE'),
  'anonymous callers cannot acquire runs');
select ok(not has_function_privilege('authenticated','private.client_sheet_sync_document(uuid)','EXECUTE'),
  'private result builder cannot bypass owner checks');
select ok((select relrowsecurity and relforcerowsecurity from pg_class
  where oid = 'private.client_sheet_sync_runs'::regclass),'run table forces RLS');
select has_table('private','client_sheet_sync_sources','scheduler source allowlist stays private');
select ok((select relrowsecurity and relforcerowsecurity from pg_class
  where oid='private.client_sheet_sync_sources'::regclass),'scheduler allowlist forces RLS');
select ok(not has_table_privilege('authenticated','private.client_sheet_sync_sources','SELECT,INSERT,UPDATE,DELETE'),
  'browser cannot read or provision scheduler source bindings');
select ok(not has_table_privilege('anon','private.client_sheet_sync_sources','SELECT,INSERT,UPDATE,DELETE'),
  'anonymous callers cannot read or provision scheduler source bindings');
select ok(not has_table_privilege('service_role','private.client_sheet_sync_sources','SELECT,INSERT,UPDATE,DELETE'),
  'generic service role cannot provision scheduler source bindings');

select id as manager from auth.users where raw_user_meta_data->>'actorKey'='manager_a'
  order by created_at desc,id limit 1 \gset
select id as other_manager from auth.users where raw_user_meta_data->>'actorKey'='manager_e2e'
  order by created_at desc,id limit 1 \gset
select id as administrator from auth.users where raw_user_meta_data->>'actorKey'='administrator'
  order by created_at desc,id limit 1 \gset
select id as seller from auth.users where raw_user_meta_data->>'actorKey'='seller_a'
  and id in (select seller_user_id from api.user_seller_scopes
    where manager_user_id=:'manager' and revoked_at is null)
  order by created_at desc,id limit 1 \gset
select email as seller_email from auth.users where id=:'seller' \gset

set local role authenticated;
select set_config('request.jwt.claim.sub',:'seller',true);
select throws_ok($$select api.begin_client_sheet_sync(repeat('a',64),'31300000-0000-4000-8000-000000000001')$$,
  'P0001','FORBIDDEN','seller cannot synchronize');
select throws_ok($$select api.get_client_sheet_sync_status(repeat('a',64))$$,
  'P0001','FORBIDDEN','seller cannot read run state');
select set_config('request.jwt.claim.sub',:'manager',true);
select is(api.get_client_sheet_sync_status(repeat('a',64)),null::jsonb,'unconfigured source has no fabricated result');
select throws_ok($$select api.begin_client_sheet_sync('sheet URL','31300000-0000-4000-8000-000000000001')$$,
  'P0001','VALIDATION_FAILED','source key must be opaque SHA-256');
select throws_ok($$select api.begin_client_sheet_sync(repeat('a',64),'bad-key')$$,
  'P0001','VALIDATION_FAILED','manual request key must be a UUID');
select throws_ok($$select api.begin_client_sheet_sync(repeat('a',64),'2000-01-01@06:00','scheduled')$$,
  'P0001','FORBIDDEN','unregistered source denies scheduled access before date validation');
select throws_ok($$select api.begin_client_sheet_sync(repeat('a',64),'2000-01-01@07:00','scheduled')$$,
  'P0001','FORBIDDEN','unregistered source denies scheduled access before slot validation');

select api.begin_client_sheet_sync(repeat('a',64),'31300000-0000-4000-8000-000000000001') as acquired \gset
select is((:'acquired')::jsonb->>'replayed','false','new intent acquires a run');
select ok((:'acquired')::jsonb->>'leaseToken' is not null,'acquisition returns an opaque lease token');
select is((:'acquired')::jsonb->'result'->>'status','running','running state is persisted before external fetch');
select throws_ok($$select api.begin_client_sheet_sync(repeat('a',64),'31300000-0000-4000-8000-000000000002')$$,
  'P0001','SYNC_BUSY','second request cannot run concurrently on the same source');
select is(api.begin_client_sheet_sync(repeat('a',64),'31300000-0000-4000-8000-000000000001')->>'replayed',
  'true','retry of active intent does not acquire a second worker');
select is(api.begin_client_sheet_sync(repeat('a',64),'31300000-0000-4000-8000-000000000001')->>'leaseToken',
  null::text,'replay never grants an active worker lease to a duplicate request');

select jsonb_build_object(
  'schemaVersion',1,'sourceName','google-sheet-synthetic','sourceChecksum',repeat('b',64),
  'totalCount',2,'acceptedCount',1,'rejectedCount',1,
  'rows',jsonb_build_array(jsonb_build_object(
    'rowNumber',2,'externalReference','SHEET-SYNC-TEST-001','name','Cliente planilha TESTE',
    'address','Rua Sintetica 1','latitude',null,'longitude',null,
    'portfolioReference','CARTEIRA-TESTE','sellerEmail',:'seller_email','status','active')),
  'issues',jsonb_build_array(jsonb_build_object(
    'rowNumber',4,'code','STATUS_REVIEW_REQUIRED','message','Corrija o status na planilha.'))
) as command \gset
select throws_ok(format('select api.finish_client_sheet_sync(%L::uuid,%L::uuid,%L::jsonb,1)',
  (:'acquired')::jsonb->>'runId','31300000-0000-4000-8000-000000000099',:'command'),
  'P0001','NOT_FOUND','wrong lease cannot apply source rows');
select set_config('request.jwt.claim.sub',:'other_manager',true);
select is(api.get_client_sheet_sync_status(repeat('a',64)),null::jsonb,'other manager cannot see the run');
select throws_ok($$select api.begin_client_sheet_sync(repeat('a',64),'31300000-0000-4000-8000-000000000001')$$,
  'P0001','NOT_FOUND','request-key knowledge does not disclose another actor result');
select throws_ok(format('select api.finish_client_sheet_sync(%L::uuid,%L::uuid,%L::jsonb,1)',
  (:'acquired')::jsonb->>'runId',(:'acquired')::jsonb->>'leaseToken',:'command'),
  'P0001','NOT_FOUND','another manager cannot use even a known lease');
select set_config('request.jwt.claim.sub',:'manager',true);
select api.finish_client_sheet_sync(((:'acquired')::jsonb->>'runId')::uuid,
  ((:'acquired')::jsonb->>'leaseToken')::uuid,(:'command')::jsonb,1,'cli') as completed \gset
select is((:'completed')::jsonb->>'status','completed_with_pending','review rows do not block valid rows');
select is((:'completed')::jsonb->>'acceptedCount','1','valid rows are counted separately');
select is((:'completed')::jsonb->>'pendingCount','1','review rows are durable');
select is((:'completed')::jsonb->>'ignoredCount','1','OUTROS count is separate from pending rows');
select is((:'completed')::jsonb->'issues'->0->>'rowNumber','4','source row number survives persistence');
select is((:'completed')::jsonb->'issues'->0->>'code','STATUS_REVIEW_REQUIRED','review reason survives persistence');
select is(api.finish_client_sheet_sync(((:'acquired')::jsonb->>'runId')::uuid,
  ((:'acquired')::jsonb->>'leaseToken')::uuid,(:'command')::jsonb,1,'cli'),(:'completed')::jsonb,
  'lost finish response replays the canonical result');
select is(api.fail_client_sheet_sync(((:'acquired')::jsonb->>'runId')::uuid,
  ((:'acquired')::jsonb->>'leaseToken')::uuid,'SYNC_FAILED'),(:'completed')::jsonb,
  'late error cannot overwrite a committed success');
select is(api.begin_client_sheet_sync(repeat('a',64),'31300000-0000-4000-8000-000000000001')->'result',
  (:'completed')::jsonb,'completed intention replays the same canonical result');
select set_config('request.jwt.claim.sub',:'administrator',true);
select is(api.get_client_sheet_sync_status(repeat('a',64)),(:'completed')::jsonb,'administrator can inspect scheduled or manager runs');
reset role;
select is((select total_count from api.import_batches where id=((:'completed')::jsonb->>'batchId')::uuid),
  2,'ignored rows are not misclassified as import rejections');
select is((select count(*)::integer from private.audit_events
  where target_id=(select id from api.clients where external_reference='SHEET-SYNC-TEST-001')
    and action='client.imported'),1,'replays produce one business audit event');
update api.clients set name='Edicao manual TESTE' where external_reference='SHEET-SYNC-TEST-001';
set local role authenticated;
select set_config('request.jwt.claim.sub',:'manager',true);
select api.begin_client_sheet_sync(repeat('a',64),'31300000-0000-4000-8000-000000000002') as reapplied \gset
select api.finish_client_sheet_sync(((:'reapplied')::jsonb->>'runId')::uuid,
  ((:'reapplied')::jsonb->>'leaseToken')::uuid,(:'command')::jsonb,1,'cli') as reapplied_result \gset
select isnt((:'reapplied_result')::jsonb->>'batchId',(:'completed')::jsonb->>'batchId',
  'new intention does not replay stale same-content batch forever');
reset role;
select is((select name from api.clients where external_reference='SHEET-SYNC-TEST-001'),
  'Cliente planilha TESTE','explicit refresh reapplies official values after manual drift');
set local role authenticated;
select set_config('request.jwt.claim.sub',:'manager',true);
select api.begin_client_sheet_sync(repeat('a',64),'31300000-0000-4000-8000-000000000003') as expired \gset
reset role;
do $membership$
begin
  execute format('grant cirne_route_executor to %I with set true granted by current_user',current_user);
end
$membership$;
set local role cirne_route_executor;
update private.client_sheet_sync_runs set lease_expires_at=clock_timestamp()-interval '1 second'
where id=((:'expired')::jsonb->>'runId')::uuid;
reset role;
do $membership$
begin
  execute format('revoke cirne_route_executor from %I granted by current_user',current_user);
end
$membership$;
set local role authenticated;
select set_config('request.jwt.claim.sub',:'manager',true);
select throws_ok(format('select api.finish_client_sheet_sync(%L::uuid,%L::uuid,%L::jsonb,1)',
  (:'expired')::jsonb->>'runId',(:'expired')::jsonb->>'leaseToken',:'command'),
  'P0001','SYNC_LEASE_EXPIRED','expired worker cannot apply a stale snapshot');
select api.begin_client_sheet_sync(repeat('a',64),'31300000-0000-4000-8000-000000000004') as recovery \gset
select is((:'recovery')::jsonb->'result'->>'status','running','new intent recovers source after lease expiration');
select is(api.begin_client_sheet_sync(repeat('a',64),'31300000-0000-4000-8000-000000000003')->'result'->>'errorCode',
  'SYNC_LEASE_EXPIRED','expired request remains an explicit terminal failure');
select api.fail_client_sheet_sync(((:'recovery')::jsonb->>'runId')::uuid,
  ((:'recovery')::jsonb->>'leaseToken')::uuid,'SYNC_FAILED') as failed \gset
select is((:'failed')::jsonb->>'status','failed','external fetch failure is persisted without import');
select is((:'failed')::jsonb->>'batchId',null::text,'failed fetch does not invent an import batch');
select is(api.begin_client_sheet_sync(repeat('a',64),'31300000-0000-4000-8000-000000000004')->'result',
  (:'failed')::jsonb,'failed intention replays failure rather than silently retrying');
reset role;
select is((select count(*)::integer from private.audit_events
  where target_id=(select id from api.clients where external_reference='SHEET-SYNC-TEST-001')
    and action='client.imported'),2,'failed or stale workers cannot mutate clients');

-- The adapter removes OUTROS and unresolved status rows from the canonical rows.
-- The persistence boundary must leave those existing clients and absent clients intact.
insert into api.clients (id,external_reference,name,address,portfolio_reference)
values
  ('31300000-0000-4000-8000-000000000201','SHEET-SYNC-ABSENT','Ausente da fonte TESTE','Rua Ausente 1','CARTEIRA-TESTE'),
  ('31300000-0000-4000-8000-000000000202','SHEET-SYNC-OUTROS','Carteira OUTROS TESTE','Rua Outros 1','CARTEIRA-TESTE');
insert into api.client_seller_scopes (client_id,seller_id,assigned_by)
values
  ('31300000-0000-4000-8000-000000000201',:'seller',:'manager'),
  ('31300000-0000-4000-8000-000000000202',:'seller',:'manager');
select to_jsonb(client) as pending_client_before from api.clients client
where external_reference='SHEET-SYNC-TEST-001' \gset
select to_jsonb(client) as absent_client_before from api.clients client
where external_reference='SHEET-SYNC-ABSENT' \gset
select to_jsonb(client) as ignored_client_before from api.clients client
where external_reference='SHEET-SYNC-OUTROS' \gset
select jsonb_agg(to_jsonb(scope) order by scope.id) as scopes_before
from api.client_seller_scopes scope where client_id in (
  select id from api.clients where external_reference in ('SHEET-SYNC-TEST-001','SHEET-SYNC-ABSENT','SHEET-SYNC-OUTROS')
) \gset
select jsonb_build_object(
  'schemaVersion',1,'sourceName','google-sheet-synthetic','sourceChecksum',repeat('d',64),
  'totalCount',1,'acceptedCount',0,'rejectedCount',1,'rows','[]'::jsonb,
  'issues',jsonb_build_array(jsonb_build_object('rowNumber',2,'code','STATUS_REVIEW_REQUIRED',
    'message','Corrija o status na planilha.'))
) as pending_only_command \gset
set local role authenticated;
select set_config('request.jwt.claim.sub',:'manager',true);
select api.begin_client_sheet_sync(repeat('a',64),'31300000-0000-4000-8000-000000000005') as pending_only_run \gset
select api.finish_client_sheet_sync(((:'pending_only_run')::jsonb->>'runId')::uuid,
  ((:'pending_only_run')::jsonb->>'leaseToken')::uuid,(:'pending_only_command')::jsonb,1,'cli') as pending_only_result \gset
select is((:'pending_only_result')::jsonb->>'status','completed_with_pending','zero accepted rows still finalize a pending-only run');
select is((:'pending_only_result')::jsonb->>'acceptedCount','0','pending-only run accepts no clients');
select is((:'pending_only_result')::jsonb->>'pendingCount','1','pending-only run retains its review row');
select is((:'pending_only_result')::jsonb->>'ignoredCount','1','pending-only run also records ignored OUTROS separately');
select ok((:'pending_only_result')::jsonb->>'completedAt' is not null,'pending-only run has a confirmed completion timestamp');
reset role;
select is((select to_jsonb(client) from api.clients client where external_reference='SHEET-SYNC-TEST-001'),
  (:'pending_client_before')::jsonb,'indefinite status leaves the existing client completely unchanged');
select is((select to_jsonb(client) from api.clients client where external_reference='SHEET-SYNC-ABSENT'),
  (:'absent_client_before')::jsonb,'client absent from source is not updated archived or deleted');
select is((select to_jsonb(client) from api.clients client where external_reference='SHEET-SYNC-OUTROS'),
  (:'ignored_client_before')::jsonb,'ignored OUTROS client is not updated archived or deleted');
select is((select jsonb_agg(to_jsonb(scope) order by scope.id) from api.client_seller_scopes scope
  where client_id in (select id from api.clients where external_reference in
    ('SHEET-SYNC-TEST-001','SHEET-SYNC-ABSENT','SHEET-SYNC-OUTROS'))),
  (:'scopes_before')::jsonb,'pending absent and ignored clients retain their original seller links');
select is((select count(*)::integer from private.audit_events where action='client.imported'
  and target_id in (select id from api.clients where external_reference in
    ('SHEET-SYNC-TEST-001','SHEET-SYNC-ABSENT','SHEET-SYNC-OUTROS'))),2,
  'pending absent and ignored rows create no business-mutation audit events');

select jsonb_build_object(
  'schemaVersion',1,'sourceName','google-sheet-synthetic','sourceChecksum',repeat('e',64),
  'totalCount',0,'acceptedCount',0,'rejectedCount',0,'rows','[]'::jsonb,'issues','[]'::jsonb
) as ignored_only_command \gset
set local role authenticated;
select set_config('request.jwt.claim.sub',:'manager',true);
select api.begin_client_sheet_sync(repeat('a',64),'31300000-0000-4000-8000-000000000006') as ignored_only_run \gset
select api.finish_client_sheet_sync(((:'ignored_only_run')::jsonb->>'runId')::uuid,
  ((:'ignored_only_run')::jsonb->>'leaseToken')::uuid,(:'ignored_only_command')::jsonb,2,'cli') as ignored_only_result \gset
select is((:'ignored_only_result')::jsonb->>'status','completed','all-ignored source finalizes an empty canonical batch');
select is((:'ignored_only_result')::jsonb->>'acceptedCount','0','all-ignored source accepts zero rows');
select is((:'ignored_only_result')::jsonb->>'pendingCount','0','all-ignored source invents no review issues');
select is((:'ignored_only_result')::jsonb->>'ignoredCount','2','all-ignored source retains its separate ignored count');
select is((:'ignored_only_result')::jsonb->'issues','[]'::jsonb,'all-ignored source has no rejection details');
reset role;
select is((select total_count from api.import_batches where id=((:'ignored_only_result')::jsonb->>'batchId')::uuid),
  0,'all-ignored source persists a confirmed zero-row batch');
select is((select to_jsonb(client) from api.clients client where external_reference='SHEET-SYNC-OUTROS'),
  (:'ignored_client_before')::jsonb,'all-ignored completion cannot mutate an existing OUTROS client');

-- Publish a synthetic historical route before explicitly inactivating its client.
do $membership$
begin
  execute format('grant cirne_route_executor to %I with set true granted by current_user',current_user);
end
$membership$;
set local role cirne_route_executor;
insert into api.routes (id,service_date,seller_id,created_by)
values ('31300000-0000-4000-8000-000000000301','2001-01-13',:'seller',:'manager');
insert into api.route_versions (id,route_id,version_number,created_by)
values ('31300000-0000-4000-8000-000000000302','31300000-0000-4000-8000-000000000301',1,:'manager');
insert into api.route_version_stops (id,route_version_id,client_id,planned_order,priority,client_context_snapshot)
select '31300000-0000-4000-8000-000000000303','31300000-0000-4000-8000-000000000302',
  id,1,0,jsonb_build_object('id',id,'name',name,'address',address,'portfolioReference',portfolio_reference)
from api.clients where external_reference='SHEET-SYNC-TEST-001';
update api.route_versions set status='published',published_by=:'manager',published_at=now(),
  seller_context_snapshot=jsonb_build_object('id',:'seller','displayName','Vendedor historico TESTE')
where id='31300000-0000-4000-8000-000000000302';
update api.routes set status='closed' where id='31300000-0000-4000-8000-000000000301';
insert into api.route_stop_executions (id,route_version_id,route_version_stop_id,execution_order,status)
values ('31300000-0000-4000-8000-000000000304','31300000-0000-4000-8000-000000000302',
  '31300000-0000-4000-8000-000000000303',1,'completed');
select to_jsonb(version) as route_version_before from api.route_versions version
where id='31300000-0000-4000-8000-000000000302' \gset
select to_jsonb(stop) as route_stop_before from api.route_version_stops stop
where id='31300000-0000-4000-8000-000000000303' \gset
select to_jsonb(execution) as route_execution_before from api.route_stop_executions execution
where id='31300000-0000-4000-8000-000000000304' \gset
reset role;
select jsonb_set((:'command')::jsonb,'{rows,0,status}','"archived"'::jsonb)
  || jsonb_build_object('sourceChecksum',repeat('f',64),'totalCount',1,'acceptedCount',1,
    'rejectedCount',0,'issues','[]'::jsonb) as inactive_command \gset
set local role authenticated;
select set_config('request.jwt.claim.sub',:'manager',true);
select api.begin_client_sheet_sync(repeat('a',64),'31300000-0000-4000-8000-000000000007') as inactive_run \gset
select api.finish_client_sheet_sync(((:'inactive_run')::jsonb->>'runId')::uuid,
  ((:'inactive_run')::jsonb->>'leaseToken')::uuid,(:'inactive_command')::jsonb,0,'cli') as inactive_result \gset
select is((:'inactive_result')::jsonb->>'status','completed','explicit INATIVO mapped to archived is accepted');
select is((:'inactive_result')::jsonb->>'acceptedCount','1','explicit inactivation imports the intended client');
reset role;
select is((select status from api.clients where external_reference='SHEET-SYNC-TEST-001'),
  'inactive','explicit INATIVO changes canonical client status to inactive');
select ok((select archived_at is not null from api.clients where external_reference='SHEET-SYNC-TEST-001'),
  'explicit inactivation records its archive timestamp');
select is((select count(*)::integer from api.clients where external_reference='SHEET-SYNC-TEST-001'),
  1,'explicit inactivation preserves rather than deletes the client');
select ok(exists(select 1 from api.client_seller_scopes
  where client_id=(select id from api.clients where external_reference='SHEET-SYNC-TEST-001')
    and seller_id=:'seller' and revoked_at is null
    and managed_by_import_batch_id=((:'inactive_result')::jsonb->>'batchId')::uuid),
  'inactivation preserves the explicit seller link under the existing importer contract');
set local role cirne_route_executor;
select is((select to_jsonb(version) from api.route_versions version where id='31300000-0000-4000-8000-000000000302'),
  (:'route_version_before')::jsonb,'inactivation preserves the published historical route version');
select is((select to_jsonb(stop) from api.route_version_stops stop where id='31300000-0000-4000-8000-000000000303'),
  (:'route_stop_before')::jsonb,'inactivation preserves the historical client snapshot and stop link');
select is((select to_jsonb(execution) from api.route_stop_executions execution where id='31300000-0000-4000-8000-000000000304'),
  (:'route_execution_before')::jsonb,'inactivation preserves completed historical route execution');
reset role;
do $membership$
begin
  execute format('revoke cirne_route_executor from %I granted by current_user',current_user);
end
$membership$;
select is((select count(*)::integer from private.audit_events where action='client.imported'
  and target_id=(select id from api.clients where external_reference='SHEET-SYNC-TEST-001')),3,
  'inactivation appends its audit event without erasing prior imports');

-- DB-admin fixture setup only: the migration/BFF never auto-register a scheduler.
do $membership$
begin
  execute format('grant cirne_route_executor to %I with set true granted by current_user',current_user);
end
$membership$;
select is((select count(*)::integer from private.client_sheet_sync_sources
  where source_key in (repeat('c',64),repeat('d',64),repeat('e',64),repeat('f',64))),0,
  'synthetic sources are denied by default before explicit DB administration');
insert into private.client_sheet_sync_sources(source_key,scheduler_actor_id)
values (repeat('c',64),:'manager'),(repeat('d',64),:'manager'),
  (repeat('e',64),:'manager'),(repeat('f',64),:'manager');
-- Durable terminal fixtures exercise authorized replay at both slots without a
-- client-controlled clock or a test that only works at 06:00/13:00 in real time.
insert into private.client_sheet_sync_runs
  (source_key,request_key,trigger,requested_by,lease_expires_at,status,completed_at,error_code)
values
  (repeat('c',64),'2000-01-01@06:00','scheduled',:'manager',now(),'failed',now(),'SYNC_FAILED'),
  (repeat('c',64),'2000-01-01@13:00','scheduled',:'manager',now(),'failed',now(),'SYNC_FAILED'),
  (repeat('c',64),'2000-01-02@06:00','scheduled',:'other_manager',now(),'failed',now(),'SYNC_FAILED'),
  (repeat('c',64),'2000-01-03@13:00','scheduled',:'administrator',now(),'failed',now(),'SYNC_FAILED');
insert into private.client_sheet_sync_runs
  (id,source_key,request_key,trigger,requested_by,lease_token,lease_expires_at,status)
values
  ('31300000-0000-4000-8000-000000000401',repeat('c',64),'2000-01-04@06:00','scheduled',:'manager',
    '31300000-0000-4000-8000-000000000411',clock_timestamp()+interval '10 minutes','running'),
  ('31300000-0000-4000-8000-000000000402',repeat('d',64),'2000-01-04@06:00','scheduled',:'manager',
    '31300000-0000-4000-8000-000000000412',clock_timestamp()+interval '10 minutes','running'),
  ('31300000-0000-4000-8000-000000000403',repeat('e',64),'2000-01-04@13:00','scheduled',:'manager',
    '31300000-0000-4000-8000-000000000413',clock_timestamp()+interval '10 minutes','running');
set local role cirne_route_executor;
select throws_ok(format('insert into private.client_sheet_sync_sources values (%L,%L::uuid)',repeat('b',64),:'manager'),
  '42501','new row violates row-level security policy for table "client_sheet_sync_sources"',
  'executor cannot self-provision scheduler bindings through its read-and-lock-only RLS policies');
select throws_ok(format('update private.client_sheet_sync_sources set scheduler_actor_id=%L::uuid where source_key=%L',
  :'other_manager',repeat('c',64)),
  '42501','new row violates row-level security policy for table "client_sheet_sync_sources"',
  'row-lock policy rejects every actual configuration update');
delete from private.client_sheet_sync_sources where source_key=repeat('c',64);
select is((select count(*)::integer from private.client_sheet_sync_sources where source_key=repeat('c',64)),1,
  'executor DELETE policy remains absent and cannot remove a binding');
set local role authenticated;
select set_config('request.jwt.claim.sub',:'other_manager',true);
select throws_ok($$select api.begin_client_sheet_sync(repeat('b',64),'2000-01-01@06:00','scheduled')$$,
  'P0001','FORBIDDEN','capable outsider cannot reserve an unknown source');
select throws_ok($$select api.begin_client_sheet_sync(repeat('c',64),'2000-01-01@06:00','scheduled')$$,
  'P0001','FORBIDDEN','capable outsider cannot inspect another actor existing scheduled key');
select throws_ok($$select api.begin_client_sheet_sync(repeat('c',64),'2000-01-02@06:00','scheduled')$$,
  'P0001','FORBIDDEN','unbound outsider cannot replay even its own legacy scheduled key');
select throws_ok($$select api.begin_client_sheet_sync(repeat('c',64),'2000-01-05@06:00','scheduled')$$,
  'P0001','FORBIDDEN','outsider is denied before slot validation or active-source locking');
select set_config('request.jwt.claim.sub',:'administrator',true);
select throws_ok($$select api.begin_client_sheet_sync(repeat('c',64),'2000-01-03@13:00','scheduled')$$,
  'P0001','FORBIDDEN','administrator cannot replay its own key without the source binding');
select throws_ok($$select api.begin_client_sheet_sync(repeat('b',64),'2000-01-01@06:00','scheduled')$$,
  'P0001','FORBIDDEN','administrator has no implicit scheduler access to unknown sources');
select set_config('request.jwt.claim.sub',:'manager',true);
select is(api.begin_client_sheet_sync(repeat('c',64),'2000-01-01@06:00','scheduled')->>'replayed',
  'true','bound actor can recover the canonical 06:00 result outside its original hour');
select is(api.begin_client_sheet_sync(repeat('c',64),'2000-01-01@13:00','scheduled')->>'replayed',
  'true','bound actor can recover the canonical 13:00 result outside its original hour');
select throws_ok($$select api.begin_client_sheet_sync(repeat('f',64),'2000-01-01@06:00','scheduled')$$,
  'P0001','VALIDATION_FAILED','bound actor cannot create a scheduled intention for a past date');
select throws_ok($$select api.begin_client_sheet_sync(repeat('f',64),'2000-01-01@07:00','scheduled')$$,
  'P0001','VALIDATION_FAILED','bound actor cannot create a third scheduled slot');
select case when extract(hour from clock_timestamp() at time zone 'America/Sao_Paulo') in (6,13)
  then lives_ok(format('select api.begin_client_sheet_sync(%L,%L,%L)',repeat('f',64),
    to_char(clock_timestamp() at time zone 'America/Sao_Paulo','YYYY-MM-DD@HH24:')||'00','scheduled'),
    'bound actor can acquire the current Sao Paulo slot')
  else throws_ok(format('select api.begin_client_sheet_sync(%L,%L,%L)',repeat('f',64),
    to_char(clock_timestamp() at time zone 'America/Sao_Paulo','YYYY-MM-DD')||'@06:00','scheduled'),
    'P0001','VALIDATION_FAILED','bound actor cannot create a new slot outside scheduled hours')
  end;
select is(api.finish_client_sheet_sync('31300000-0000-4000-8000-000000000401',
  '31300000-0000-4000-8000-000000000411',(:'ignored_only_command')::jsonb,0,'cli')->>'status',
  'completed','bound scheduler can finish a previously acquired run atomically');
reset role;
delete from private.client_sheet_sync_sources where source_key=repeat('d',64);
update private.client_sheet_sync_sources set scheduler_actor_id=:'other_manager' where source_key=repeat('e',64);
set local role authenticated;
select set_config('request.jwt.claim.sub',:'manager',true);
select throws_ok(format('select api.finish_client_sheet_sync(%L::uuid,%L::uuid,%L::jsonb,0)',
  '31300000-0000-4000-8000-000000000402','31300000-0000-4000-8000-000000000412',:'command'),
  'P0001','FORBIDDEN','removing scheduler binding after acquisition prevents client import');
select throws_ok(format('select api.finish_client_sheet_sync(%L::uuid,%L::uuid,%L::jsonb,0)',
  '31300000-0000-4000-8000-000000000403','31300000-0000-4000-8000-000000000413',:'command'),
  'P0001','FORBIDDEN','reassigning scheduler binding after acquisition prevents old actor import');
select throws_ok($$select api.begin_client_sheet_sync(repeat('e',64),'2000-01-04@13:00','scheduled')$$,
  'P0001','FORBIDDEN','reassigned old scheduler cannot replay its acquired scheduled key');
reset role;
select is((select count(*)::integer from private.audit_events where action='client.imported'
  and target_id=(select id from api.clients where external_reference='SHEET-SYNC-TEST-001')),3,
  'revoked or reassigned scheduler creates no client writes or audit mutations');
select is((select count(*)::integer from private.client_sheet_sync_runs
  where id in ('31300000-0000-4000-8000-000000000402','31300000-0000-4000-8000-000000000403')
    and status='running' and batch_id is null),2,'rejected scheduler completions do not persist a batch');
do $membership$
begin
  execute format('revoke cirne_route_executor from %I granted by current_user',current_user);
end
$membership$;

-- Identity and capability are revalidated by every RPC, including an acquired run.
set local role authenticated;
select set_config('request.jwt.claim.sub',:'manager',true);
select api.begin_client_sheet_sync(repeat('a',64),'31300000-0000-4000-8000-000000000008') as access_run \gset
reset role;
select to_jsonb(profile) as manager_before from api.user_profiles profile where id=:'manager' \gset
update api.user_profiles set status='inactive',blocked_at=now() where id=:'manager';
set local role authenticated;
select set_config('request.jwt.claim.sub',:'manager',true);
select throws_ok($$select api.begin_client_sheet_sync(repeat('a',64),'31300000-0000-4000-8000-000000000009')$$,
  'P0001','FORBIDDEN','blocked manager cannot begin a synchronization');
select throws_ok($$select api.get_client_sheet_sync_status(repeat('a',64))$$,
  'P0001','FORBIDDEN','blocked manager cannot inspect synchronization results');
select throws_ok(format('select api.finish_client_sheet_sync(%L::uuid,%L::uuid,%L::jsonb,0)',
  (:'access_run')::jsonb->>'runId',(:'access_run')::jsonb->>'leaseToken',:'command'),
  'P0001','FORBIDDEN','blocking manager after acquisition prevents import');
select throws_ok(format('select api.fail_client_sheet_sync(%L::uuid,%L::uuid,%L)',
  (:'access_run')::jsonb->>'runId',(:'access_run')::jsonb->>'leaseToken','SYNC_FAILED'),
  'P0001','FORBIDDEN','blocked manager cannot mutate acquired run state');
reset role;
update api.user_profiles set status=(:'manager_before')::jsonb->>'status',
  blocked_at=((:'manager_before')::jsonb->>'blocked_at')::timestamptz where id=:'manager';
delete from api.role_permissions where permission_code='clients.import' and role_id in (
  select role_id from api.user_role_assignments where user_id=:'manager' and revoked_at is null
);
set local role authenticated;
select set_config('request.jwt.claim.sub',:'manager',true);
select throws_ok($$select api.begin_client_sheet_sync(repeat('a',64),'31300000-0000-4000-8000-000000000009')$$,
  'P0001','FORBIDDEN','active manager without clients.import cannot begin a synchronization');
select throws_ok($$select api.get_client_sheet_sync_status(repeat('a',64))$$,
  'P0001','FORBIDDEN','active manager without clients.import cannot read run results');
select throws_ok(format('select api.finish_client_sheet_sync(%L::uuid,%L::uuid,%L::jsonb,0)',
  (:'access_run')::jsonb->>'runId',(:'access_run')::jsonb->>'leaseToken',:'command'),
  'P0001','FORBIDDEN','capability removal after acquisition prevents import');
select throws_ok(format('select api.fail_client_sheet_sync(%L::uuid,%L::uuid,%L)',
  (:'access_run')::jsonb->>'runId',(:'access_run')::jsonb->>'leaseToken','SYNC_FAILED'),
  'P0001','FORBIDDEN','manager without capability cannot mutate acquired run state');
reset role;
select is((select count(*)::integer from private.audit_events where action='client.imported'
  and target_id=(select id from api.clients where external_reference='SHEET-SYNC-TEST-001')),3,
  'blocked and capability-revoked requests cause no client writes');

select * from finish();
rollback;
