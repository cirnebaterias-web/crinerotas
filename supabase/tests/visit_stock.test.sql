begin;

select plan(45);

select has_table('api', 'stock_snapshots', 'stock snapshot table exists');
select has_function('api', 'save_visit_stock', array['uuid', 'uuid', 'jsonb'], 'direct stock wrapper exists');
select ok(has_function_privilege('authenticated', 'api.save_visit_stock(uuid,uuid,jsonb)', 'EXECUTE'), 'authenticated can execute stock wrapper');
select ok(not has_function_privilege('anon', 'api.save_visit_stock(uuid,uuid,jsonb)', 'EXECUTE'), 'anon cannot save stock');
select ok(not has_function_privilege('anon', 'private.sync_event(uuid,jsonb)', 'EXECUTE'), 'anon cannot execute private sync');
select ok(not has_function_privilege('authenticated', 'private.sync_event(uuid,jsonb)', 'EXECUTE'), 'authenticated cannot execute private sync');
select ok(has_function_privilege('cirne_visit_executor', 'private.sync_event(uuid,jsonb)', 'EXECUTE'), 'visit executor can call private sync');
select ok(not has_table_privilege('authenticated', 'api.stock_snapshots', 'SELECT'), 'authenticated cannot read stock directly');
select ok(not has_function_privilege('anon', 'private.get_visit_stock_result(uuid)', 'EXECUTE'), 'anon cannot execute private stock reader');
select ok(not has_function_privilege('authenticated', 'private.get_visit_stock_result(uuid)', 'EXECUTE'), 'authenticated cannot execute private stock reader');
select ok(not has_function_privilege('anon', 'private.apply_visit_stock_saved(uuid,jsonb)', 'EXECUTE'), 'anon cannot execute private stock writer');
select ok(not has_function_privilege('authenticated', 'private.apply_visit_stock_saved(uuid,jsonb)', 'EXECUTE'), 'authenticated cannot execute private stock writer');
select ok(has_function_privilege('cirne_sync_executor', 'private.get_visit_stock_result(uuid)', 'EXECUTE'), 'sync executor can read canonical stock');
select ok(has_function_privilege('cirne_sync_executor', 'private.apply_visit_stock_saved(uuid,jsonb)', 'EXECUTE'), 'sync executor can apply stock');

select id as seller_a_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'seller_a' \gset
select id as seller_b_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'seller_b' \gset
select id as manager_a_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'manager_a' \gset
select id as administrator_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'administrator' \gset

update api.parameter_sets set status = 'retired' where status = 'published';
insert into api.parameter_sets (id, version, status, valid_from, published_at, published_by)
values ('90000000-0000-4000-8000-000000000098', 98, 'published',
  '2098-01-01T00:00:00Z', '2098-01-01T00:00:00Z', :'administrator_id')
on conflict (id) do update set
  version = excluded.version,
  status = excluded.status,
  valid_from = excluded.valid_from,
  published_at = excluded.published_at,
  published_by = excluded.published_by;

insert into api.clients (id, external_reference, name, address, portfolio_reference)
values ('10000000-0000-4000-8000-000000000098', 'STOCK-098', 'Cliente Estoque', 'Endereco estoque', 'CARTEIRA-ESTOQUE')
on conflict (id) do update set name = excluded.name;

set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_a_id', true);
select api.create_route_draft(jsonb_build_object(
  'schemaVersion', 1, 'serviceDate', '2098-09-17', 'sellerId', :'seller_a_id',
  'stops', jsonb_build_array(jsonb_build_object(
    'clientId', '10000000-0000-4000-8000-000000000098', 'plannedOrder', 1, 'priority', 0
  ))
)) as stock_route \gset
reset role;
select (:'stock_route')::jsonb ->> 'routeId' as stock_route_id \gset
select id as stock_stop_id from api.route_version_stops
where route_version_id = ((:'stock_route')::jsonb ->> 'routeVersionId')::uuid \gset
set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_a_id', true);
select api.publish_route(:'stock_route_id'::uuid, 1);
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', :'seller_a_id', true);
select api.start_visit(
  '22000000-0000-4000-8000-000000000098',
  '77000000-0000-4000-8000-000000000098',
  jsonb_build_object(
    'schemaVersion', 1,
    'offlineId', '55000000-0000-4000-8000-000000000098',
    'routeVersionStopId', :'stock_stop_id',
    'deviceStartedAt', '2098-09-17T12:00:00.000Z'
  )
) as started \gset
select api.save_visit_stock(
  '22000000-0000-4000-8000-000000000098',
  '77000000-0000-4000-8000-000000000099',
  jsonb_build_object(
    'schemaVersion', 1,
    'offlineId', '55000000-0000-4000-8000-000000000098',
    'heliarQuantity', 0,
    'mouraQuantity', 5,
    'observation', 'Conferido no local',
    'deviceSavedAt', '2098-09-17T12:05:00.000Z'
  )
) as first_stock \gset
reset role;

select is((:'first_stock')::jsonb ->> 'visitId', (:'started')::jsonb ->> 'visitId', 'stock resolves the canonical visit');
select is((:'first_stock')::jsonb ->> 'offlineId', '55000000-0000-4000-8000-000000000098', 'stock preserves offline identity');
select is(((:'first_stock')::jsonb ->> 'heliarQuantity')::integer, 0, 'zero is persisted as an informed quantity');
select is(((:'first_stock')::jsonb ->> 'mouraQuantity')::integer, 5, 'positive Moura quantity is persisted');
select is((:'first_stock')::jsonb ->> 'observation', 'Conferido no local', 'optional observation is persisted');
select is((select count(*)::integer from api.stock_snapshots where visit_id = ((:'started')::jsonb ->> 'visitId')::uuid), 1, 'visit has one canonical snapshot');
select is((select count(*)::integer from private.sync_events where operation = 'visit.stock.saved.v1'
  and aggregate_id = '55000000-0000-4000-8000-000000000098'), 1, 'stock creates one confirmed sync event');
select is((select count(*)::integer from private.audit_events where action = 'visit.stock.saved.v1'
  and target_id = ((:'started')::jsonb ->> 'visitId')::uuid), 1, 'stock appends one audit fact');

set local role authenticated;
select set_config('request.jwt.claim.sub', :'seller_a_id', true);
select is(api.save_visit_stock(
  '22000000-0000-4000-8000-000000000098',
  '77000000-0000-4000-8000-000000000099',
  jsonb_build_object('schemaVersion', 1, 'offlineId', '55000000-0000-4000-8000-000000000098',
    'heliarQuantity', 0, 'mouraQuantity', 5, 'observation', 'Conferido no local',
    'deviceSavedAt', '2098-09-17T12:05:00.000Z')
), (:'first_stock')::jsonb, 'exact replay returns the same canonical snapshot');
select throws_ok(
  $$select api.save_visit_stock(
    '22000000-0000-4000-8000-000000000098', '77000000-0000-4000-8000-000000000099',
    '{"schemaVersion":2,"offlineId":"55000000-0000-4000-8000-000000000098","heliarQuantity":0,"mouraQuantity":5,"observation":"Conferido no local","deviceSavedAt":"2098-09-17T12:05:00.000Z"}'::jsonb)$$,
  'P0001', 'VALIDATION_FAILED', 'direct stock replay rejects an unsupported schema version');
select throws_ok(
  $$select api.save_visit_stock(
    '22000000-0000-4000-8000-000000000098', '77000000-0000-4000-8000-000000000099',
    '{"schemaVersion":null,"offlineId":"55000000-0000-4000-8000-000000000098","heliarQuantity":0,"mouraQuantity":5,"observation":"Conferido no local","deviceSavedAt":"2098-09-17T12:05:00.000Z"}'::jsonb)$$,
  'P0001', 'VALIDATION_FAILED', 'direct stock replay rejects a null schema version');
select throws_ok(
  $$select api.save_visit_stock(
    '22000000-0000-4000-8000-000000000098', '77000000-0000-4000-8000-000000000099',
    '{"schemaVersion":"1","offlineId":"55000000-0000-4000-8000-000000000098","heliarQuantity":0,"mouraQuantity":5,"observation":"Conferido no local","deviceSavedAt":"2098-09-17T12:05:00.000Z"}'::jsonb)$$,
  'P0001', 'VALIDATION_FAILED', 'direct stock replay rejects a string schema version');
select throws_ok(
  $$select api.save_visit_stock(
    '22000000-0000-4000-8000-000000000098', '77000000-0000-4000-8000-000000000099',
    '{"schemaVersion":1,"offlineId":"55000000-0000-4000-8000-000000000098","heliarQuantity":1,"mouraQuantity":5,"deviceSavedAt":"2098-09-17T12:05:00.000Z"}'::jsonb)$$,
  'P0001', 'IDEMPOTENCY_KEY_REUSED', 'same key with divergent stock is rejected');
select throws_ok(
  $$select api.save_visit_stock(
    '22000000-0000-4000-8000-000000000098', '77000000-0000-4000-8000-000000000090',
    '{"schemaVersion":1,"offlineId":"55000000-0000-4000-8000-000000000098","heliarQuantity":-1,"mouraQuantity":5,"deviceSavedAt":"2098-09-17T12:06:00.000Z"}'::jsonb)$$,
  'P0001', 'VALIDATION_FAILED', 'negative stock is rejected');
select throws_ok(
  $$select api.save_visit_stock(
    '22000000-0000-4000-8000-000000000098', '77000000-0000-4000-8000-000000000091',
    '{"schemaVersion":1,"offlineId":"55000000-0000-4000-8000-000000000098","heliarQuantity":1.5,"mouraQuantity":5,"deviceSavedAt":"2098-09-17T12:06:00.000Z"}'::jsonb)$$,
  'P0001', 'VALIDATION_FAILED', 'decimal stock is rejected');
select throws_ok(
  $$select api.save_visit_stock(
    '22000000-0000-4000-8000-000000000098', '77000000-0000-4000-8000-000000000092',
    '{"schemaVersion":1,"offlineId":"55000000-0000-4000-8000-000000000098","heliarQuantity":1,"mouraQuantity":5,"unit":"battery","deviceSavedAt":"2098-09-17T12:06:00.000Z"}'::jsonb)$$,
  'P0001', 'VALIDATION_FAILED', 'unknown business fields are rejected');

select api.save_visit_stock(
  '22000000-0000-4000-8000-000000000098',
  '77000000-0000-4000-8000-000000000093',
  jsonb_build_object('schemaVersion', 1, 'offlineId', '55000000-0000-4000-8000-000000000098',
    'heliarQuantity', 2, 'mouraQuantity', 7, 'deviceSavedAt', '2098-09-17T12:07:00.000Z')
) as edited_stock \gset
select is(api.save_visit_stock(
  '22000000-0000-4000-8000-000000000098',
  '77000000-0000-4000-8000-000000000099',
  jsonb_build_object('schemaVersion', 1, 'offlineId', '55000000-0000-4000-8000-000000000098',
    'heliarQuantity', 0, 'mouraQuantity', 5, 'observation', 'Conferido no local',
    'deviceSavedAt', '2098-09-17T12:05:00.000Z')
), (:'first_stock')::jsonb, 'replay after a later edit returns the original canonical stock result');
reset role;
select is(((:'edited_stock')::jsonb ->> 'heliarQuantity')::integer, 2, 'later event updates the canonical snapshot');
select is((select heliar_quantity from api.stock_snapshots where visit_id = ((:'started')::jsonb ->> 'visitId')::uuid), 2, 'old replay does not overwrite the latest stock values');
select is((select count(*)::integer from api.stock_snapshots where visit_id = ((:'started')::jsonb ->> 'visitId')::uuid), 1, 'editing does not duplicate the snapshot');
select is((select count(*)::integer from private.audit_events where action = 'visit.stock.saved.v1'
  and target_id = ((:'started')::jsonb ->> 'visitId')::uuid), 2, 'editing appends a second audit fact');
select ok((select before_data is not null from private.audit_events where action = 'visit.stock.saved.v1'
  and target_id = ((:'started')::jsonb ->> 'visitId')::uuid order by occurred_at desc limit 1), 'edit audit preserves before data');

select jsonb_build_object(
  'heliar', heliar_quantity,
  'moura', moura_quantity,
  'event', last_event_id,
  'savedAt', device_saved_at
) as stock_before_audit_failure
from api.stock_snapshots where visit_id = ((:'started')::jsonb ->> 'visitId')::uuid \gset
select count(*)::integer as audits_before_failure from private.audit_events
where action = 'visit.stock.saved.v1' and target_id = ((:'started')::jsonb ->> 'visitId')::uuid \gset
do $audit_owner$
begin
  execute pg_catalog.format('grant cirne_sync_executor to %I with set true granted by current_user', current_user);
end
$audit_owner$;
set local role cirne_sync_executor;
revoke insert on private.audit_events from cirne_visit_executor;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', :'seller_a_id', true);
select throws_ok(
  $$select api.save_visit_stock(
    '22000000-0000-4000-8000-000000000098', '77000000-0000-4000-8000-000000000094',
    '{"schemaVersion":1,"offlineId":"55000000-0000-4000-8000-000000000098","heliarQuantity":9,"mouraQuantity":9,"deviceSavedAt":"2098-09-17T12:08:00.000Z"}'::jsonb)$$,
  '42501', null, 'audit failure aborts the entire stock update');
reset role;
set local role cirne_sync_executor;
grant insert on private.audit_events to cirne_visit_executor;
reset role;
do $audit_owner$
begin
  execute pg_catalog.format('revoke cirne_sync_executor from %I granted by current_user', current_user);
end
$audit_owner$;
select is((select jsonb_build_object(
  'heliar', heliar_quantity,
  'moura', moura_quantity,
  'event', last_event_id,
  'savedAt', device_saved_at
) from api.stock_snapshots where visit_id = ((:'started')::jsonb ->> 'visitId')::uuid),
  (:'stock_before_audit_failure')::jsonb, 'audit failure rolls back the stock snapshot');
select is((select count(*)::integer from private.sync_events
  where operation = 'visit.stock.saved.v1' and idempotency_key = '77000000-0000-4000-8000-000000000094'),
  0, 'audit failure does not reserve or confirm the stock idempotency key');
select is((select count(*)::integer from private.audit_events
  where action = 'visit.stock.saved.v1' and target_id = ((:'started')::jsonb ->> 'visitId')::uuid),
  :audits_before_failure::integer, 'failed stock update leaves no audit fact');

set local role authenticated;
select set_config('request.jwt.claim.sub', :'seller_a_id', true);
select throws_ok(
  $$select api.sync_event('22000000-0000-4000-8000-000000000097',
    '{"eventId":"66000000-0000-4000-8000-000000000097","idempotencyKey":"77000000-0000-4000-8000-000000000097","operation":"visit.stock.saved.v1","schemaVersion":1,"sequence":2,"aggregateType":"visit","aggregateId":"55000000-0000-4000-8000-000000000097","occurredAt":"2098-09-17T12:08:00.000Z","payload":{"offlineId":"55000000-0000-4000-8000-000000000097","heliarQuantity":0,"mouraQuantity":0,"deviceSavedAt":"2098-09-17T12:08:00.000Z"}}'::jsonb)$$,
  'P0001', 'EVENT_OUT_OF_ORDER', 'stock waits for canonical visit start');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', :'seller_b_id', true);
select throws_ok(
  $$select api.save_visit_stock('22000000-0000-4000-8000-000000000098',
    '77000000-0000-4000-8000-000000000096',
    '{"schemaVersion":1,"offlineId":"55000000-0000-4000-8000-000000000098","heliarQuantity":0,"mouraQuantity":0,"deviceSavedAt":"2098-09-17T12:09:00.000Z"}'::jsonb)$$,
  'P0001', 'VALIDATION_FAILED', 'another seller receives a non-enumerating denial');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_a_id', true);
select throws_ok(
  $$select api.save_visit_stock('22000000-0000-4000-8000-000000000098',
    '77000000-0000-4000-8000-000000000095',
    '{"schemaVersion":1,"offlineId":"55000000-0000-4000-8000-000000000098","heliarQuantity":0,"mouraQuantity":0,"deviceSavedAt":"2098-09-17T12:09:00.000Z"}'::jsonb)$$,
  'P0001', 'FORBIDDEN', 'manager cannot save seller stock');
reset role;

select is((select count(*)::integer from private.sync_events where operation = 'visit.stock.saved.v1'
  and aggregate_id = '55000000-0000-4000-8000-000000000098'), 2, 'only successful stock intentions are confirmed');
select is((select sequence from private.sync_events where operation = 'visit.stock.saved.v1'
  and aggregate_id = '55000000-0000-4000-8000-000000000098' order by sequence desc limit 1), 3, 'stock edits preserve aggregate sequence');

select * from finish();
rollback;
