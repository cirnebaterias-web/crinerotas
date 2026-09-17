begin;

select plan(59);

select has_function(
  'api',
  'reorder_route_execution',
  array['uuid', 'jsonb', 'uuid', 'text'],
  'execution order wrapper exists'
);
select ok((
  select condeferrable
  from pg_catalog.pg_constraint
  where conrelid = 'api.route_stop_executions'::regclass
    and conname = 'route_stop_executions_order_key'
), 'execution order uniqueness is deferrable');
select ok(not (
  select condeferred
  from pg_catalog.pg_constraint
  where conrelid = 'api.route_stop_executions'::regclass
    and conname = 'route_stop_executions_order_key'
), 'execution order uniqueness remains initially immediate');
select ok(
  has_function_privilege(
    'authenticated',
    'api.reorder_route_execution(uuid,jsonb,uuid,text)',
    'EXECUTE'
  ),
  'authenticated can call the narrow execution order wrapper'
);
select ok(
  not has_function_privilege(
    'anon',
    'api.reorder_route_execution(uuid,jsonb,uuid,text)',
    'EXECUTE'
  ),
  'anon cannot reorder routes'
);
select is((
  select count(*)::integer
  from api.role_permissions
  where permission_code in ('route.reorder_self', 'route.reorder_scoped')
), 2, 'only the two explicit reorder capabilities are added');

select id as seller_a_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'seller_a' \gset
select id as seller_b_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'seller_b' \gset
select id as manager_a_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'manager_a' \gset
select id as blocked_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'blocked' \gset
select id as admin_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'administrator' \gset

insert into api.clients (id, external_reference, name, address, portfolio_reference)
values
  ('10000000-0000-4000-8000-000000000001', 'SYN-001', 'Cliente Sintético 01', 'Endereço sintético 01', 'CARTEIRA-SINTETICA-A'),
  ('10000000-0000-4000-8000-000000000002', 'SYN-002', 'Cliente Sintético 02', 'Endereço sintético 02', 'CARTEIRA-SINTETICA-A'),
  ('10000000-0000-4000-8000-000000000003', 'SYN-003', 'Cliente Sintético 03', 'Endereço sintético 03', 'CARTEIRA-SINTETICA-A')
on conflict (id) do update set name = excluded.name;

set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_a_id', true);
select api.create_route_draft(jsonb_build_object(
  'schemaVersion', 1,
  'serviceDate', '2099-09-20',
  'sellerId', :'seller_a_id',
  'stops', jsonb_build_array(
    jsonb_build_object('clientId', '10000000-0000-4000-8000-000000000001', 'plannedOrder', 1, 'priority', 1),
    jsonb_build_object('clientId', '10000000-0000-4000-8000-000000000002', 'plannedOrder', 3, 'priority', 0),
    jsonb_build_object('clientId', '10000000-0000-4000-8000-000000000003', 'plannedOrder', 5, 'priority', 0)
  )
)) as draft_result \gset
select is((:'draft_result')::jsonb ->> 'status', 'draft', 'manager creates the reorder fixture');
select (:'draft_result')::jsonb ->> 'routeId' as route_id \gset
select (:'draft_result')::jsonb ->> 'routeVersionId' as route_version_id \gset
select (:'draft_result')::jsonb #>> '{stops,0,routeVersionStopId}' as stop_1_id \gset
select (:'draft_result')::jsonb #>> '{stops,1,routeVersionStopId}' as stop_2_id \gset
select (:'draft_result')::jsonb #>> '{stops,2,routeVersionStopId}' as stop_3_id \gset
select throws_ok(
  format('select api.reorder_route_execution(%L::uuid, %L::jsonb, %L::uuid, ''web'')',
    :'route_id',
    jsonb_build_object('schemaVersion', 1, 'expectedVersion', 1, 'pendingStopIds', jsonb_build_array(:'stop_3_id', :'stop_2_id', :'stop_1_id')),
    '60000000-0000-4000-8000-000000000020'),
  'P0001', 'VERSION_CONFLICT', 'a draft cannot be operationally reordered'
);
select api.publish_route(:'route_id'::uuid, 1) as publication_result \gset
select is((:'publication_result')::jsonb ->> 'status', 'published', 'manager publishes the reorder fixture');
reset role;

select is((select lock_version from api.routes where id = :'route_id'::uuid), 2, 'published fixture starts at aggregate execution version two');
select jsonb_agg(to_jsonb(stop_row) order by id)::text as original_composition
from api.route_version_stops stop_row where route_version_id = :'route_version_id'::uuid \gset

set local role authenticated;
select set_config('request.jwt.claim.sub', :'seller_a_id', true);
select api.reorder_route_execution(
  :'route_id'::uuid,
  jsonb_build_object(
    'schemaVersion', 1,
    'expectedVersion', 2,
    'pendingStopIds', jsonb_build_array(:'stop_3_id', :'stop_2_id', :'stop_1_id')
  ),
  '60000000-0000-4000-8000-000000000001'::uuid,
  'cli'
) as first_reorder \gset
select is((:'first_reorder')::jsonb ->> 'changed', 'true', 'seller swaps all pending positions atomically');
select is((:'first_reorder')::jsonb ->> 'executionVersion', '3', 'effective reorder advances the aggregate exactly once');
select is(
  (:'first_reorder')::jsonb -> 'pendingStopIds',
  jsonb_build_array(:'stop_3_id', :'stop_2_id', :'stop_1_id'),
  'result preserves the requested pending order'
);
reset role;

select is((
  select jsonb_agg(route_version_stop_id order by execution_order)
  from api.route_stop_executions
  where route_version_id = :'route_version_id'::uuid
), jsonb_build_array(:'stop_3_id', :'stop_2_id', :'stop_1_id'), 'database stores the complete swapped order');
select is((
  select jsonb_agg(planned_order order by planned_order)
  from api.route_version_stops
  where route_version_id = :'route_version_id'::uuid
), '[1, 3, 5]'::jsonb, 'planned order remains immutable');
select is((
  select count(*)::integer
  from private.audit_events
  where target_id = :'route_id'::uuid and action = 'route.execution_order.changed'
), 1, 'effective reorder appends one audit event');
select is((select actor_id from private.audit_events
  where target_id = :'route_id'::uuid and action = 'route.execution_order.changed'),
  :'seller_a_id'::uuid, 'audit actor is derived from the authenticated seller');
select is((
  select jsonb_build_object('origin', origin, 'requestId', request_id)
  from private.audit_events
  where target_id = :'route_id'::uuid and action = 'route.execution_order.changed'
), jsonb_build_object('origin', 'cli', 'requestId', '60000000-0000-4000-8000-000000000001'::uuid), 'audit stores origin and request id');
select is((
  select before_data -> 'pendingStopIds'
  from private.audit_events
  where target_id = :'route_id'::uuid and action = 'route.execution_order.changed'
), jsonb_build_array(:'stop_1_id', :'stop_2_id', :'stop_3_id'), 'audit preserves the previous order');
select is((
  select after_data -> 'pendingStopIds'
  from private.audit_events
  where target_id = :'route_id'::uuid and action = 'route.execution_order.changed'
), jsonb_build_array(:'stop_3_id', :'stop_2_id', :'stop_1_id'), 'audit preserves the resulting order');

set local role authenticated;
select set_config('request.jwt.claim.sub', :'seller_a_id', true);
select is(api.get_route(:'route_id'::uuid) ->> 'schemaVersion', '3', 'canonical route contract is version three');
select is(api.get_route(:'route_id'::uuid) ->> 'executionVersion', '3', 'canonical route exposes the aggregate execution version');
select is((
  select jsonb_agg(stop ->> 'routeVersionStopId')
  from jsonb_array_elements(api.get_route(:'route_id'::uuid) -> 'stops') stop
), jsonb_build_array(:'stop_3_id', :'stop_2_id', :'stop_1_id'), 'canonical route is ordered by execution order');

select api.reorder_route_execution(
  :'route_id'::uuid,
  jsonb_build_object(
    'schemaVersion', 1,
    'expectedVersion', 3,
    'pendingStopIds', jsonb_build_array(:'stop_3_id', :'stop_2_id', :'stop_1_id')
  ),
  '60000000-0000-4000-8000-000000000002'::uuid,
  'pwa'
) as no_op_result \gset
select is((:'no_op_result')::jsonb ->> 'changed', 'false', 'canonical order is a stable no-op');
select is((:'no_op_result')::jsonb ->> 'executionVersion', '3', 'no-op does not advance aggregate version');
reset role;
select is((
  select count(*)::integer
  from private.audit_events
  where target_id = :'route_id'::uuid and action = 'route.execution_order.changed'
), 1, 'no-op does not create false audit');

set local role authenticated;
select set_config('request.jwt.claim.sub', :'seller_a_id', true);
select throws_ok(
  format(
    'select api.reorder_route_execution(%L::uuid, %L::jsonb, %L::uuid, ''cli'')',
    :'route_id',
    jsonb_build_object('schemaVersion', 1, 'expectedVersion', 3, 'pendingStopIds', jsonb_build_array(:'stop_1_id', :'stop_1_id', :'stop_3_id')),
    '60000000-0000-4000-8000-000000000003'
  ),
  'P0001', 'VALIDATION_FAILED', 'duplicate pending stop is rejected atomically'
);
select throws_ok(
  format(
    'select api.reorder_route_execution(%L::uuid, %L::jsonb, %L::uuid, ''cli'')',
    :'route_id',
    jsonb_build_object('schemaVersion', 1, 'expectedVersion', 3, 'pendingStopIds', jsonb_build_array(:'stop_1_id', :'stop_3_id')),
    '60000000-0000-4000-8000-000000000004'
  ),
  'P0001', 'VALIDATION_FAILED', 'missing pending stop is rejected atomically'
);
select throws_ok(
  format(
    'select api.reorder_route_execution(%L::uuid, %L::jsonb, %L::uuid, ''cli'')',
    :'route_id',
    jsonb_build_object('schemaVersion', 1, 'expectedVersion', 3, 'pendingStopIds', jsonb_build_array(:'stop_1_id', :'stop_2_id', '70000000-0000-4000-8000-000000000099')),
    '60000000-0000-4000-8000-000000000005'
  ),
  'P0001', 'VALIDATION_FAILED', 'foreign pending stop is rejected atomically'
);
reset role;
select is((select lock_version from api.routes where id = :'route_id'::uuid), 3, 'invalid commands leave aggregate version unchanged');
select is((
  select jsonb_agg(route_version_stop_id order by execution_order)
  from api.route_stop_executions
  where route_version_id = :'route_version_id'::uuid
), jsonb_build_array(:'stop_3_id', :'stop_2_id', :'stop_1_id'), 'invalid commands leave execution order unchanged');

set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_a_id', true);
select throws_ok(
  format(
    'select api.reorder_route_execution(%L::uuid, %L::jsonb, %L::uuid, ''web'')',
    :'route_id',
    jsonb_build_object('schemaVersion', 1, 'expectedVersion', 2, 'pendingStopIds', jsonb_build_array(:'stop_1_id', :'stop_2_id', :'stop_3_id')),
    '60000000-0000-4000-8000-000000000006'
  ),
  'P0001', 'VERSION_CONFLICT', 'second actor with stale aggregate version receives a conflict'
);
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', :'seller_b_id', true);
select throws_ok(
  format(
    'select api.reorder_route_execution(%L::uuid, %L::jsonb, %L::uuid, ''pwa'')',
    :'route_id',
    jsonb_build_object('schemaVersion', 1, 'expectedVersion', 3, 'pendingStopIds', jsonb_build_array(:'stop_3_id', :'stop_2_id', :'stop_1_id')),
    '60000000-0000-4000-8000-000000000007'
  ),
  'P0001', 'NOT_FOUND', 'foreign seller cannot enumerate the route through reorder'
);
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', :'blocked_id', true);
select throws_ok(
  format(
    'select api.reorder_route_execution(%L::uuid, %L::jsonb, %L::uuid, ''pwa'')',
    :'route_id',
    jsonb_build_object('schemaVersion', 1, 'expectedVersion', 3, 'pendingStopIds', jsonb_build_array(:'stop_3_id', :'stop_2_id', :'stop_1_id')),
    '60000000-0000-4000-8000-000000000008'
  ),
  'P0001', 'FORBIDDEN', 'blocked actor cannot reorder a route'
);
reset role;

do $grant_fixture_owner$
begin
  execute pg_catalog.format('grant cirne_route_executor to %I with set true granted by current_user', current_user);
end
$grant_fixture_owner$;
set local role cirne_route_executor;
update api.route_stop_executions
set status = 'in_visit'
where route_version_stop_id = :'stop_2_id'::uuid;
reset role;
do $revoke_fixture_owner$
begin
  execute pg_catalog.format('revoke cirne_route_executor from %I granted by current_user', current_user);
end
$revoke_fixture_owner$;
select is((
  select jsonb_build_object('status', status, 'executionOrder', execution_order)
  from api.route_stop_executions
  where route_version_stop_id = :'stop_2_id'::uuid
), jsonb_build_object('status', 'in_visit', 'executionOrder', 3), 'fixture marks one non-pending stop at its existing position');

set local role authenticated;
select set_config('request.jwt.claim.sub', :'seller_a_id', true);
select api.reorder_route_execution(
  :'route_id'::uuid,
  jsonb_build_object(
    'schemaVersion', 1,
    'expectedVersion', 3,
    'pendingStopIds', jsonb_build_array(:'stop_1_id', :'stop_3_id')
  ),
  '60000000-0000-4000-8000-000000000009'::uuid,
  'pwa'
) as pending_only_result \gset
select is((:'pending_only_result')::jsonb ->> 'changed', 'true', 'seller reorders exactly the remaining pending stops');
reset role;
select is((select lock_version from api.routes where id = :'route_id'::uuid), 4, 'pending-only reorder advances root once');
select is((
  select jsonb_build_object('status', status, 'executionOrder', execution_order)
  from api.route_stop_executions
  where route_version_stop_id = :'stop_2_id'::uuid
), jsonb_build_object('status', 'in_visit', 'executionOrder', 3), 'non-pending state and position are preserved');
select is((
  select jsonb_agg(route_version_stop_id order by execution_order)
  from api.route_stop_executions
  where route_version_id = :'route_version_id'::uuid and status = 'pending'
), jsonb_build_array(:'stop_1_id', :'stop_3_id'), 'server derives the available pending positions');
select is((
  select count(*)::integer
  from private.audit_events
  where target_id = :'route_id'::uuid and action = 'route.execution_order.changed'
), 2, 'pending-only reorder appends exactly one additional audit event');

set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_a_id', true);
select api.reorder_route_execution(
  :'route_id'::uuid,
  jsonb_build_object(
    'schemaVersion', 1,
    'expectedVersion', 4,
    'pendingStopIds', jsonb_build_array(:'stop_3_id', :'stop_1_id')
  ),
  '60000000-0000-4000-8000-000000000010'::uuid,
  'web'
) as manager_result \gset
select is((:'manager_result')::jsonb ->> 'changed', 'true', 'manager in scope can reorder pending stops');
reset role;
select is((select lock_version from api.routes where id = :'route_id'::uuid), 5, 'scoped manager reorder advances root once');

set local role authenticated;
select set_config('request.jwt.claim.sub', :'seller_a_id', true);
select throws_ok(
  format('select api.reorder_route_execution(%L::uuid, %L::jsonb, %L::uuid, ''cli'')',
    :'route_id',
    jsonb_build_object('schemaVersion', 1, 'expectedVersion', 5, 'pendingStopIds', jsonb_build_array(:'stop_1_id', :'stop_2_id', :'stop_3_id')),
    '60000000-0000-4000-8000-000000000011'),
  'P0001', 'VALIDATION_FAILED', 'a stop that is no longer pending rejects the entire command'
);
select throws_ok(
  format('select api.reorder_route_execution(%L::uuid, %L::jsonb, %L::uuid, ''cli'')',
    :'route_id', malformed.command, '60000000-0000-4000-8000-000000000012'),
  'P0001', 'VALIDATION_FAILED', malformed.description
)
from (values
  ('{"schemaVersion":null,"expectedVersion":5,"pendingStopIds":[]}'::jsonb, 'null schema version is rejected'),
  ('{"schemaVersion":"1","expectedVersion":5,"pendingStopIds":[]}'::jsonb, 'string schema version is rejected'),
  ('{"schemaVersion":1,"expectedVersion":null,"pendingStopIds":[]}'::jsonb, 'null expected version is rejected'),
  ('{"schemaVersion":1,"expectedVersion":5,"pendingStopIds":[null]}'::jsonb, 'null stop ID is rejected')
) malformed(command, description);
reset role;

-- Force the audit insert to fail after the order/version writes, proving rollback.
do $grant_audit_owner$
begin
  execute pg_catalog.format('grant cirne_sync_executor to %I with set true granted by current_user', current_user);
end
$grant_audit_owner$;
set local role cirne_sync_executor;
revoke insert on private.audit_events from cirne_route_executor;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', :'seller_a_id', true);
select throws_ok(
  format('select api.reorder_route_execution(%L::uuid, %L::jsonb, %L::uuid, ''cli'')',
    :'route_id',
    jsonb_build_object('schemaVersion', 1, 'expectedVersion', 5, 'pendingStopIds', jsonb_build_array(:'stop_1_id', :'stop_3_id')),
    '60000000-0000-4000-8000-000000000013'),
  '42501', null, 'audit failure rejects the entire mutation'
);
reset role;
set local role cirne_sync_executor;
grant insert on private.audit_events to cirne_route_executor;
reset role;
do $revoke_audit_owner$
begin
  execute pg_catalog.format('revoke cirne_sync_executor from %I granted by current_user', current_user);
end
$revoke_audit_owner$;
select is((select lock_version from api.routes where id = :'route_id'::uuid), 5, 'audit failure rolls back the aggregate version');
select is((select jsonb_agg(route_version_stop_id order by execution_order)
  from api.route_stop_executions where route_version_id = :'route_version_id'::uuid),
  jsonb_build_array(:'stop_3_id', :'stop_2_id', :'stop_1_id'), 'audit failure rolls back every position');

-- Remove only the synthetic delegation to prove current scope is re-evaluated.
update api.user_seller_scopes set revoked_at = clock_timestamp()
where seller_user_id = :'seller_a_id'::uuid and revoked_at is null;
set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_a_id', true);
select throws_ok(
  format('select api.reorder_route_execution(%L::uuid, %L::jsonb, %L::uuid, ''web'')',
    :'route_id',
    jsonb_build_object('schemaVersion', 1, 'expectedVersion', 5, 'pendingStopIds', jsonb_build_array(:'stop_1_id', :'stop_3_id')),
    '60000000-0000-4000-8000-000000000014'),
  'P0001', 'NOT_FOUND', 'manager with revoked scope cannot enumerate the route'
);
select set_config('request.jwt.claim.sub', :'admin_id', true);
select throws_ok(
  format('select api.reorder_route_execution(%L::uuid, %L::jsonb, %L::uuid, ''web'')',
    :'route_id',
    jsonb_build_object('schemaVersion', 1, 'expectedVersion', 5, 'pendingStopIds', jsonb_build_array(:'stop_1_id', :'stop_3_id')),
    '60000000-0000-4000-8000-000000000015'),
  'P0001', 'FORBIDDEN', 'role without reorder capability cannot mutate the route'
);
select throws_ok(
  $$select api.reorder_route_execution('70000000-0000-4000-8000-000000000099'::uuid,
    '{"schemaVersion":1,"expectedVersion":1,"pendingStopIds":["70000000-0000-4000-8000-000000000001"]}'::jsonb,
    '60000000-0000-4000-8000-000000000016'::uuid, 'web')$$,
  'P0001', 'FORBIDDEN', 'role without capability receives the same denial for an unknown route'
);
reset role;
select is((select jsonb_agg(to_jsonb(stop_row) order by id)
  from api.route_version_stops stop_row where route_version_id = :'route_version_id'::uuid),
  :'original_composition'::jsonb, 'snapshots, priority and every published composition field remain unchanged');
select is((select count(*)::integer from private.audit_events
  where target_id = :'route_id'::uuid and action = 'route.execution_order.changed'),
  3, 'all failed attempts leave audit append-only and unchanged');

set local role authenticated;
select set_config('request.jwt.claim.sub', :'seller_a_id', true);
select throws_ok(
  format('update api.route_stop_executions set execution_order = 50 where route_version_stop_id = %L::uuid', :'stop_1_id'),
  '42501', null, 'authenticated cannot bypass the reorder function with direct SQL'
);
reset role;

select is((
  select jsonb_agg(planned_order order by planned_order)
  from api.route_version_stops
  where route_version_id = :'route_version_id'::uuid
), '[1, 3, 5]'::jsonb, 'all reorder attempts preserve published composition');
select ok((
  select relrowsecurity and relforcerowsecurity
  from pg_catalog.pg_class
  where oid = 'api.route_stop_executions'::regclass
), 'RLS remains enabled and forced on executions');
select is((
  select jsonb_build_object('origin', origin, 'requestId', request_id)
  from private.audit_events
  where target_id = :'route_id'::uuid
    and action = 'route.execution_order.changed'
    and request_id = '60000000-0000-4000-8000-000000000010'::uuid
), jsonb_build_object('origin', 'web', 'requestId', '60000000-0000-4000-8000-000000000010'::uuid), 'manager audit stores web origin and request id');

select * from finish();
rollback;
