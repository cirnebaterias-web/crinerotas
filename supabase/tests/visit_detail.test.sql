begin;

select plan(34);

select has_view('api', 'visit_details_v', 'narrow visit detail projection exists');
select has_function('api', 'get_visit_detail', array['uuid', 'uuid', 'text'], 'authorized visit detail reader exists');
select has_function('api', 'authorize_visit_attachment_download', array['uuid', 'uuid', 'text'], 'attachment authorization exists');
select ok(not has_table_privilege('authenticated', 'api.visit_details_v', 'SELECT'), 'authenticated cannot select the projection directly');
select ok(has_function_privilege('authenticated', 'api.get_visit_detail(uuid,uuid,text)', 'EXECUTE'), 'authenticated can execute the guarded detail reader');
select ok(not has_function_privilege('anon', 'api.get_visit_detail(uuid,uuid,text)', 'EXECUTE'), 'anon cannot execute the detail reader');
select ok(has_function_privilege('authenticated', 'private.can_manager_download_visit_evidence(text,text)', 'EXECUTE'), 'authenticated can evaluate the caller-scoped Storage policy');
select ok(not has_function_privilege('anon', 'private.can_manager_download_visit_evidence(text,text)', 'EXECUTE'), 'anon cannot evaluate the sensitive Storage policy');
select ok(
  not (select rolcanlogin or rolbypassrls or rolsuper from pg_catalog.pg_roles where rolname = 'cirne_visit_detail_executor'),
  'detail executor cannot login or bypass RLS'
);
select is((select count(*)::integer from api.role_permissions where permission_code in (
  'visit.location.read_scoped', 'visit.evidence.read_scoped'
)), 0, 'sensitive capabilities are not assigned to any role by default');

select id as seller_a_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'seller_a' \gset
select id as manager_a_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'manager_a' \gset
select id as administrator_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'administrator' \gset
select id as blocked_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'blocked' \gset
select id as manager_role_id from api.roles where code = 'manager' \gset

update api.parameter_sets set status = 'retired' where status = 'published';
insert into api.parameter_sets (id, version, status, valid_from, published_at, published_by)
values ('92000000-0000-4000-8000-000000000001', 201, 'published', '2099-01-01T00:00:00Z', '2099-01-01T00:00:00Z', :'administrator_id');
insert into api.clients (id, external_reference, name, address, portfolio_reference)
values ('92000000-0000-4000-8000-000000000002', 'DETAIL-01', 'Cliente Detalhe', 'Endereco historico', 'DETAIL');

set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_a_id', true);
select api.create_route_draft(jsonb_build_object(
  'schemaVersion', 1, 'serviceDate', '2099-10-26', 'sellerId', :'seller_a_id',
  'stops', jsonb_build_array(jsonb_build_object(
    'clientId', '92000000-0000-4000-8000-000000000002', 'plannedOrder', 1, 'priority', 2
  ))
)) as detail_route \gset
select api.publish_route(((:'detail_route')::jsonb ->> 'routeId')::uuid, 1) as detail_publication \gset
reset role;
select id as detail_stop_id from api.route_version_stops
where route_version_id = ((:'detail_route')::jsonb ->> 'routeVersionId')::uuid \gset

set local role authenticated;
select set_config('request.jwt.claim.sub', :'seller_a_id', true);
select api.start_visit(
  '92000000-0000-4000-8000-000000000003',
  '92000000-0000-4000-8000-000000000004',
  jsonb_build_object(
    'schemaVersion', 1,
    'offlineId', '92000000-0000-4000-8000-000000000005',
    'routeVersionStopId', :'detail_stop_id',
    'deviceStartedAt', '2099-10-26T12:00:00Z',
    'location', jsonb_build_object('latitude', '-7.115', 'longitude', '-34.864', 'accuracyM', '10', 'distanceM', '5')
  )
) as detail_visit \gset
reset role;
select (:'detail_visit')::jsonb ->> 'visitId' as detail_visit_id \gset

grant cirne_visit_executor to postgres with set true;
set local role cirne_visit_executor;
update api.location_events
set issues = array['camera_unavailable','gps_unavailable','gps_low_accuracy','outside_radius','client_location_missing'],
  exception_reason = 'Justificativa sintética para o limite de exceções.'
where visit_id = :'detail_visit_id'::uuid and kind = 'start';
insert into api.location_events (
  visit_id, kind, device_captured_at, server_received_at, issues, exception_reason
) values (
  :'detail_visit_id'::uuid, 'completion', '2099-10-26T13:00:00Z', '2099-10-26T13:00:01Z',
  array['camera_unavailable','gps_unavailable','gps_low_accuracy','outside_radius','client_location_missing'],
  'Justificativa sintética para o limite de exceções.'
);
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_a_id', true);
select api.get_visit_detail(:'detail_visit_id', '92000000-0000-4000-8000-000000000006', 'web') as base_detail \gset
select is((:'base_detail')::jsonb ->> 'visitId', :'detail_visit_id', 'manager reads an in-scope visit');
select is((:'base_detail')::jsonb #>> '{context,client,name}', 'Cliente Detalhe', 'historical client snapshot is returned');
select is((:'base_detail')::jsonb #>> '{location,state}', 'withheld', 'location is withheld without the sensitive capability');
select is((:'base_detail')::jsonb #>> '{evidence,state}', 'withheld', 'evidence is withheld without the sensitive capability');
select is(jsonb_array_length((:'base_detail')::jsonb -> 'exceptions'), 10, 'exceptions are deterministically bounded by the contract limit');
select ok((:'base_detail')::text !~* '(storagePath|signedUrl|idempotencyKey|payloadHash|latitude|longitude)', 'base response structurally redacts sensitive and internal fields');
select api.get_management_day('2099-10-26', 'America/Recife') as day_detail \gset
select is((:'day_detail')::jsonb #>> '{routes,0,visits,0,visitId}', :'detail_visit_id', 'management day exposes the bounded visit reference');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', :'seller_a_id', true);
select throws_ok(format($sql$select api.get_visit_detail(%L, %L, 'web')$sql$,
  :'detail_visit_id', '92000000-0000-4000-8000-000000000007'), 'P0001', 'NOT_FOUND', 'seller cannot read management detail');
select set_config('request.jwt.claim.sub', :'administrator_id', true);
select throws_ok(format($sql$select api.get_visit_detail(%L, %L, 'web')$sql$,
  :'detail_visit_id', '92000000-0000-4000-8000-000000000008'), 'P0001', 'NOT_FOUND', 'administrator has no implicit commercial access');
select set_config('request.jwt.claim.sub', :'blocked_id', true);
select throws_ok(format($sql$select api.get_visit_detail(%L, %L, 'web')$sql$,
  :'detail_visit_id', '92000000-0000-4000-8000-000000000009'), 'P0001', 'NOT_FOUND', 'blocked actor cannot read detail');
reset role;

update api.user_seller_scopes set revoked_at = statement_timestamp()
where manager_user_id = :'manager_a_id'::uuid and seller_user_id = :'seller_a_id'::uuid and revoked_at is null;
set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_a_id', true);
select throws_ok(format($sql$select api.get_visit_detail(%L, %L, 'web')$sql$,
  :'detail_visit_id', '92000000-0000-4000-8000-000000000010'), 'P0001', 'NOT_FOUND', 'out-of-scope detail is non-enumerating');
reset role;
update api.user_seller_scopes set revoked_at = null
where manager_user_id = :'manager_a_id'::uuid and seller_user_id = :'seller_a_id'::uuid;

insert into api.role_permissions (role_id, permission_code) values
  (:'manager_role_id', 'visit.location.read_scoped'),
  (:'manager_role_id', 'visit.evidence.read_scoped');
insert into api.visit_attachments (
  id, offline_id, visit_id, seller_id, device_id, purpose, storage_path,
  content_type, byte_size, checksum, captured_at, expires_at, status,
  reservation_key, reservation_hash, confirmation_key, verified_at
)
select
  '92000000-0000-4000-8000-000000000013',
  '92000000-0000-4000-8000-000000000014',
  visit.id, visit.seller_id, visit.device_id, 'visit_checkin',
  'seller/' || visit.seller_id || '/visit/' || visit.id || '/92000000-0000-4000-8000-000000000013.jpg',
  'image/jpeg', 4, repeat('a', 64), '2099-10-26T12:00:00Z', '2100-04-24T12:00:00Z',
  'verified', '92000000-0000-4000-8000-000000000015', repeat('b', 64),
  '92000000-0000-4000-8000-000000000016', '2099-10-26T12:00:01Z'
from api.visits visit where visit.id = :'detail_visit_id'::uuid;
insert into storage.objects (bucket_id, name, metadata)
select 'visit-evidence', attachment.storage_path, '{"size":4,"mimetype":"image/jpeg"}'::jsonb
from api.visit_attachments attachment where attachment.id = '92000000-0000-4000-8000-000000000013';
set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_a_id', true);
select api.get_visit_detail(:'detail_visit_id', '92000000-0000-4000-8000-000000000011', 'web') as sensitive_detail \gset
select is((:'sensitive_detail')::jsonb #>> '{location,state}', 'available', 'synthetic explicit capability reveals location');
select is((:'sensitive_detail')::jsonb #>> '{evidence,state}', 'available', 'synthetic explicit capability reveals verified evidence metadata only');
select is((:'sensitive_detail')::jsonb #>> '{location,latitude}', '-7.115', 'authorized location preserves decimal text');
select api.authorize_visit_attachment_download(
  '92000000-0000-4000-8000-000000000013',
  '92000000-0000-4000-8000-000000000017', 'web'
) as attachment_authorization \gset
select is((:'attachment_authorization')::jsonb ->> 'evidenceKind', 'visit', 'download authorization identifies the canonical evidence kind');
select is((:'attachment_authorization')::jsonb ->> 'parentId', :'detail_visit_id', 'download authorization remains bound to the canonical visit');
select is((:'attachment_authorization')::jsonb ->> 'attachmentId', '92000000-0000-4000-8000-000000000013', 'download authorization remains bound to the requested attachment');
select ok((:'attachment_authorization')::text !~* '(bucket|storagePath|seller/)', 'direct Data API authorization exposes no bucket or internal storage path');
select is((select count(*)::integer from storage.objects
  where bucket_id = 'visit-evidence'
    and name = 'seller/' || :'seller_a_id' || '/visit/' || :'detail_visit_id' || '/92000000-0000-4000-8000-000000000013.jpg'),
  1, 'caller-scoped Storage RLS authorizes the verified object');
select throws_ok($$select api.authorize_visit_attachment_download(
  '92000000-0000-4000-8000-000000000099',
  '92000000-0000-4000-8000-000000000012', 'web'
)$$, 'P0001', 'NOT_FOUND', 'missing evidence remains non-enumerating even with explicit capability');
reset role;
select is((select count(*)::integer from private.audit_events
  where target_id = '92000000-0000-4000-8000-000000000013'::uuid
    and action = 'visit.evidence.download_url.issued.v1'
    and request_id = '92000000-0000-4000-8000-000000000017'), 1,
  'authorized download appends one audit event');
select ok(not exists (select 1 from private.audit_events
  where request_id = '92000000-0000-4000-8000-000000000017'
    and coalesce(after_data::text, '') ~* '(bucket|storagePath|seller/)'),
  'download audit contains no bucket or internal storage path');
select is((select count(*)::integer from private.audit_events
  where target_id = :'detail_visit_id'::uuid and action = 'visit.location.read.v1'
    and request_id = '92000000-0000-4000-8000-000000000011'), 1, 'sensitive location read appends one audit event');
select ok(not exists (select 1 from private.audit_events
  where request_id = '92000000-0000-4000-8000-000000000011'
    and coalesce(after_data::text, '') ~* '(latitude|longitude|-7.115|-34.864)'), 'sensitive audit contains no coordinates');

select * from finish();
rollback;
