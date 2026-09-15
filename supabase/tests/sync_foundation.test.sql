begin;

select plan(27);

select has_table('private', 'sync_events', 'private sync event ledger exists');
select has_table('private', 'audit_events', 'private append-only audit ledger exists');
select has_function('api', 'sync_event', array['uuid', 'jsonb'], 'public sync wrapper exists');
select has_function('private', 'sync_event', array['uuid', 'jsonb'], 'private sync function exists');
select ok(
  not (select rolcanlogin or rolbypassrls or rolsuper from pg_catalog.pg_roles where rolname = 'cirne_sync_executor'),
  'sync executor cannot login or bypass RLS'
);
select is(
  (select pg_catalog.pg_get_userbyid(proowner) from pg_catalog.pg_proc
   where oid = 'api.sync_event(uuid,jsonb)'::regprocedure),
  'cirne_sync_executor',
  'public wrapper has dedicated owner'
);
select ok(
  (select prosecdef from pg_catalog.pg_proc where oid = 'api.sync_event(uuid,jsonb)'::regprocedure),
  'public wrapper is security definer'
);
select ok(
  (select pg_catalog.pg_get_functiondef('private.sync_event(uuid,jsonb)'::regprocedure) like '%SET search_path TO %'),
  'private function pins empty search_path'
);
select ok(not has_table_privilege('authenticated', 'private.sync_events', 'SELECT'), 'authenticated cannot read sync ledger');
select ok(not has_table_privilege('authenticated', 'private.audit_events', 'SELECT'), 'authenticated cannot read audit ledger');
select ok(has_function_privilege('authenticated', 'api.sync_event(uuid,jsonb)', 'EXECUTE'), 'authenticated can execute wrapper');
select ok(not has_function_privilege('anon', 'api.sync_event(uuid,jsonb)', 'EXECUTE'), 'anon cannot execute wrapper');
select is(
  (select count(*)::integer from api.role_permissions where permission_code = 'sync.write_self'),
  1,
  'only seller receives the explicit sync capability'
);

select id as seller_a_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'seller_a' \gset
select id as manager_a_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'manager_a' \gset
select id as blocked_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'blocked' \gset

set local role authenticated;
select set_config('request.jwt.claim.sub', :'seller_a_id', true);
select api.sync_event(
  '22222222-2222-4222-8222-222222222222',
  jsonb_build_object(
    'eventId', '66666666-6666-4666-8666-666666666661',
    'idempotencyKey', '77777777-7777-4777-8777-777777777771',
    'operation', 'visit.draft.saved',
    'schemaVersion', 1,
    'sequence', 1,
    'aggregateType', 'visit_draft',
    'aggregateId', '55555555-5555-4555-8555-555555555555',
    'occurredAt', '2026-09-14T12:00:00.000Z',
    'payload', jsonb_build_object(
      'draftOfflineId', '55555555-5555-4555-8555-555555555555',
      'routeVersionStopId', '44444444-4444-4444-8444-444444444441',
      'acknowledged', true
    )
  )
) as first_result \gset
select is((:'first_result')::jsonb ->> 'status', 'confirmed', 'first event is confirmed');
reset role;

select is((
  select count(*)::integer from private.sync_events
  where actor_id = :'seller_a_id'
    and device_id = '22222222-2222-4222-8222-222222222222'
    and aggregate_id = '55555555-5555-4555-8555-555555555555'
), 1, 'one canonical event is stored');
select is((
  select count(*)::integer from private.audit_events
  where actor_id = :'seller_a_id'
    and target_id = '55555555-5555-4555-8555-555555555555'
), 1, 'confirmation and audit are stored together');

set local role authenticated;
select set_config('request.jwt.claim.sub', :'seller_a_id', true);
set local timezone to 'America/Sao_Paulo';
select is(
  api.sync_event(
    '22222222-2222-4222-8222-222222222222',
    jsonb_build_object(
      'eventId', '66666666-6666-4666-8666-666666666661',
      'idempotencyKey', '77777777-7777-4777-8777-777777777771',
      'operation', 'visit.draft.saved', 'schemaVersion', 1, 'sequence', 1,
      'aggregateType', 'visit_draft', 'aggregateId', '55555555-5555-4555-8555-555555555555',
      'occurredAt', '2026-09-14T12:00:00.000Z',
      'payload', jsonb_build_object(
        'draftOfflineId', '55555555-5555-4555-8555-555555555555',
        'routeVersionStopId', '44444444-4444-4444-8444-444444444441',
        'acknowledged', true
      )
    )
  ),
  (:'first_result')::jsonb,
  'same key and content returns the original result'
);
select throws_ok(
  $$select api.sync_event(
    '22222222-2222-4222-8222-222222222222',
    jsonb_build_object(
      'eventId', '66666666-6666-4666-8666-666666666661',
      'idempotencyKey', '77777777-7777-4777-8777-777777777771',
      'operation', 'visit.draft.saved', 'schemaVersion', 1, 'sequence', 1,
      'aggregateType', 'visit_draft', 'aggregateId', '55555555-5555-4555-8555-555555555555',
      'occurredAt', '2026-09-14T12:00:00.000Z',
      'payload', jsonb_build_object(
        'draftOfflineId', '55555555-5555-4555-8555-555555555555',
        'routeVersionStopId', '44444444-4444-4444-8444-444444444441',
        'acknowledged', false
      )
    )
  )$$,
  'P0001', 'IDEMPOTENCY_KEY_REUSED', 'same key with divergent content is rejected'
);
select throws_ok(
  $$select api.sync_event(
    '22222222-2222-4222-8222-222222222222',
    jsonb_build_object(
      'eventId', '66666666-6666-4666-8666-666666666663',
      'idempotencyKey', '77777777-7777-4777-8777-777777777773',
      'operation', 'visit.draft.saved', 'schemaVersion', 1, 'sequence', 3,
      'aggregateType', 'visit_draft', 'aggregateId', '55555555-5555-4555-8555-555555555555',
      'occurredAt', '2026-09-14T12:02:00.000Z',
      'payload', jsonb_build_object(
        'draftOfflineId', '55555555-5555-4555-8555-555555555555',
        'routeVersionStopId', '44444444-4444-4444-8444-444444444441',
        'acknowledged', true
      )
    )
  )$$,
  'P0001', 'EVENT_OUT_OF_ORDER', 'sequence gaps are rejected'
);
select is(
  api.sync_event(
    '22222222-2222-4222-8222-222222222222',
    jsonb_build_object(
      'eventId', '66666666-6666-4666-8666-666666666662',
      'idempotencyKey', '77777777-7777-4777-8777-777777777772',
      'operation', 'visit.draft.saved', 'schemaVersion', 1, 'sequence', 2,
      'aggregateType', 'visit_draft', 'aggregateId', '55555555-5555-4555-8555-555555555555',
      'occurredAt', '2026-09-14T12:01:00.000Z',
      'payload', jsonb_build_object(
        'draftOfflineId', '55555555-5555-4555-8555-555555555555',
        'routeVersionStopId', '44444444-4444-4444-8444-444444444441',
        'acknowledged', true
      )
    )
  ) ->> 'status',
  'confirmed',
  'next contiguous sequence is confirmed'
);
reset role;

select is((
  select count(*)::integer from private.sync_events
  where actor_id = :'seller_a_id'
    and device_id = '22222222-2222-4222-8222-222222222222'
    and aggregate_id = '55555555-5555-4555-8555-555555555555'
), 2, 'replay and failures do not duplicate events');
select is((
  select count(*)::integer from private.audit_events
  where actor_id = :'seller_a_id'
    and target_id = '55555555-5555-4555-8555-555555555555'
), 2, 'only canonical confirmations append audits');

set local role authenticated;
select set_config('request.jwt.claim.sub', :'seller_a_id', true);
select throws_ok(
  $$select api.sync_event(
    '22222222-2222-4222-8222-222222222222',
    jsonb_build_object(
      'eventId', '66666666-6666-4666-8666-666666666664',
      'idempotencyKey', '77777777-7777-4777-8777-777777777774',
      'operation', 'visit.draft.saved', 'schemaVersion', 1, 'sequence', 1,
      'aggregateType', 'visit_draft', 'aggregateId', '55555555-5555-4555-8555-555555555556',
      'occurredAt', '2026-09-14T12:03:00.000Z',
      'payload', jsonb_build_object(
        'draftOfflineId', '55555555-5555-4555-8555-555555555556',
        'routeVersionStopId', '44444444-4444-4444-8444-444444444441',
        'acknowledged', true
      ),
      'unexpected', 'rejected'
    )
  )$$,
  'P0001', 'VALIDATION_FAILED', 'unknown command fields are rejected'
);
select throws_ok(
  $$select api.sync_event(
    '22222222-2222-4222-8222-222222222222',
    jsonb_build_object(
      'eventId', '66666666-6666-4666-8666-666666666664',
      'idempotencyKey', '77777777-7777-4777-8777-777777777774',
      'operation', 'visit.draft.saved', 'schemaVersion', 1, 'sequence', 1,
      'aggregateType', 'visit_draft', 'aggregateId', '55555555-5555-4555-8555-555555555556',
      'occurredAt', null,
      'payload', jsonb_build_object(
        'draftOfflineId', '55555555-5555-4555-8555-555555555556',
        'routeVersionStopId', '44444444-4444-4444-8444-444444444441',
        'acknowledged', true
      )
    )
  )$$,
  'P0001', 'VALIDATION_FAILED', 'null required command fields are rejected'
);
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_a_id', true);
select throws_ok(
  $$select api.sync_event('22222222-2222-4222-8222-222222222222', '{}'::jsonb)$$,
  'P0001', 'FORBIDDEN', 'manager without capability is denied'
);
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', :'blocked_id', true);
select throws_ok(
  $$select api.sync_event('22222222-2222-4222-8222-222222222222', '{}'::jsonb)$$,
  'P0001', 'FORBIDDEN', 'blocked actor is denied'
);
select throws_ok('select * from private.sync_events', '42501', null, 'direct private ledger access is denied');
reset role;

select * from finish();
rollback;
