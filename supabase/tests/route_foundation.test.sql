begin;

select plan(53);

select has_table('api', 'clients', 'clients exists');
select has_table('api', 'routes', 'routes exists');
select has_table('api', 'route_versions', 'route_versions exists');
select has_table('api', 'route_version_stops', 'route_version_stops exists');
select has_table('api', 'route_stop_executions', 'route_stop_executions exists');
select has_function('api', 'create_route_draft', array['jsonb'], 'draft wrapper exists');
select has_function('api', 'publish_route', array['uuid', 'integer'], 'publish wrapper exists');
select has_function('api', 'get_route', array['uuid'], 'route reader exists');
select has_function('api', 'get_my_route_for_date', array['date'], 'seller route reader exists');
select ok(
  not (select rolcanlogin or rolbypassrls or rolsuper from pg_catalog.pg_roles where rolname = 'cirne_route_executor'),
  'route executor cannot login or bypass RLS'
);
select is((
  select count(*)::integer from pg_catalog.pg_class
  where oid in (
    'api.clients'::regclass,
    'api.routes'::regclass,
    'api.route_versions'::regclass,
    'api.route_version_stops'::regclass,
    'api.route_stop_executions'::regclass
  ) and relrowsecurity and relforcerowsecurity
), 5, 'RLS is enabled and forced on every route table');
select ok(not has_table_privilege('authenticated', 'api.clients', 'SELECT'), 'authenticated cannot read clients directly');
select ok(not has_table_privilege('authenticated', 'api.routes', 'SELECT'), 'authenticated cannot read routes directly');
select ok(not has_table_privilege('authenticated', 'api.route_versions', 'SELECT'), 'authenticated cannot read versions directly');
select ok(not has_table_privilege('authenticated', 'api.route_version_stops', 'SELECT'), 'authenticated cannot read stops directly');
select ok(not has_table_privilege('authenticated', 'api.route_stop_executions', 'SELECT'), 'authenticated cannot read executions directly');
select ok(has_function_privilege('authenticated', 'api.create_route_draft(jsonb)', 'EXECUTE'), 'authenticated can execute draft wrapper');
select ok(has_function_privilege('authenticated', 'api.publish_route(uuid,integer)', 'EXECUTE'), 'authenticated can execute publish wrapper');
select ok(has_function_privilege('authenticated', 'api.get_route(uuid)', 'EXECUTE'), 'authenticated can execute route reader');
select ok(has_function_privilege('authenticated', 'api.get_my_route_for_date(date)', 'EXECUTE'), 'authenticated can execute seller reader');
select ok(not has_function_privilege('anon', 'api.create_route_draft(jsonb)', 'EXECUTE'), 'anon cannot create routes');
select is((
  select count(*)::integer from api.role_permissions
  where permission_code in ('route.read_self', 'route.plan_scoped', 'route.read_scoped')
), 3, 'only three explicit route permissions are added');
select is((
  select jsonb_agg(permission_code order by permission_code)
  from api.role_permissions where role_id = '00000000-0000-4000-8000-000000000002'
), '["identity.read_self", "route.plan_scoped", "route.read_scoped"]'::jsonb, 'manager receives scoped route permissions');
select is((
  select jsonb_agg(permission_code order by permission_code)
  from api.role_permissions where role_id = '00000000-0000-4000-8000-000000000001'
), '["identity.read_self", "route.read_self", "sync.write_self"]'::jsonb, 'seller receives self route read capability');

select id as seller_a_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'seller_a' \gset
select id as seller_b_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'seller_b' \gset
select id as manager_a_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'manager_a' \gset
select id as blocked_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'blocked' \gset

insert into api.clients (id, external_reference, name, address, portfolio_reference)
values
  ('10000000-0000-4000-8000-000000000001', 'SYN-001', 'Cliente Sintético 01', 'Endereço sintético 01', 'CARTEIRA-SINTETICA-A'),
  ('10000000-0000-4000-8000-000000000002', 'SYN-002', 'Cliente Sintético 02', 'Endereço sintético 02', 'CARTEIRA-SINTETICA-A')
on conflict (id) do update set name = excluded.name;

set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_a_id', true);
select api.create_route_draft(jsonb_build_object(
  'schemaVersion', 1,
  'serviceDate', '2099-09-15',
  'sellerId', :'seller_a_id',
  'stops', jsonb_build_array(
    jsonb_build_object('clientId', '10000000-0000-4000-8000-000000000001', 'plannedOrder', 1, 'priority', 1),
    jsonb_build_object('clientId', '10000000-0000-4000-8000-000000000002', 'plannedOrder', 3, 'priority', 0)
  )
)) as draft_result \gset
select is((:'draft_result')::jsonb ->> 'status', 'draft', 'manager creates a draft');
reset role;

select (:'draft_result')::jsonb ->> 'routeId' as route_id \gset
select (:'draft_result')::jsonb ->> 'routeVersionId' as route_version_id \gset
select is((select count(*)::integer from api.routes where id = :'route_id'::uuid), 1, 'one route root is stored');
select is((select count(*)::integer from api.route_versions where id = :'route_version_id'::uuid), 1, 'one draft version is stored');
select is((select count(*)::integer from api.route_version_stops where route_version_id = :'route_version_id'::uuid), 2, 'two route stops are stored');
select is((select count(*)::integer from private.audit_events where target_id = :'route_id'::uuid), 1, 'draft and audit commit together');

set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_a_id', true);
select throws_ok(
  format($test$select api.create_route_draft(jsonb_build_object(
    'schemaVersion', 1, 'serviceDate', '2099-09-17', 'sellerId', %L,
    'stops', jsonb_build_array(jsonb_build_object(
      'clientId', '10000000-0000-4000-8000-000000000099', 'plannedOrder', 1, 'priority', 0
    ))
  ))$test$, :'seller_a_id'),
  'P0001', 'VALIDATION_FAILED', 'unknown client is rejected'
);
reset role;
select is((
  select count(*)::integer from api.routes
  where seller_id = :'seller_a_id'::uuid and service_date = '2099-09-17'
), 0, 'invalid draft leaves no partial route');

set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_a_id', true);
select throws_ok(
  format($test$select api.create_route_draft(jsonb_build_object(
    'schemaVersion', 1, 'serviceDate', '2099-09-16', 'sellerId', %L,
    'stops', jsonb_build_array(jsonb_build_object(
      'clientId', '10000000-0000-4000-8000-000000000001', 'plannedOrder', 1, 'priority', 0
    ))
  ))$test$, :'seller_b_id'),
  'P0001', 'FORBIDDEN', 'manager cannot plan for seller outside its scope'
);
select throws_ok(
  format($test$select api.create_route_draft(jsonb_build_object(
    'schemaVersion', 1, 'serviceDate', '2099-09-15', 'sellerId', %L,
    'stops', jsonb_build_array(jsonb_build_object(
      'clientId', '10000000-0000-4000-8000-000000000001', 'plannedOrder', 1, 'priority', 0
    ))
  ))$test$, :'seller_a_id'),
  'P0001', 'VERSION_CONFLICT', 'one route root per seller and date is enforced'
);

select api.publish_route(:'route_id'::uuid, 1) as publication_result \gset
select is((:'publication_result')::jsonb ->> 'status', 'published', 'manager publishes the expected draft version');
reset role;

select is((select lock_version from api.routes where id = :'route_id'::uuid), 2, 'publication advances aggregate version');
select is((select count(*)::integer from api.route_stop_executions where route_version_id = :'route_version_id'::uuid), 2, 'publication creates one execution per stop');
select is((select count(*)::integer from api.route_version_stops where route_version_id = :'route_version_id'::uuid and client_context_snapshot is not null), 2, 'every published stop has an immutable client snapshot');
select is((select count(*)::integer from private.audit_events where target_id = :'route_id'::uuid), 2, 'publication appends exactly one audit event');

set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_a_id', true);
select throws_ok(
  format('select api.publish_route(%L::uuid, 1)', :'route_id'),
  'P0001', 'VERSION_CONFLICT', 'replaying stale publication is rejected'
);
reset role;
select has_trigger('api', 'route_versions', 'route_versions_guard_published', 'published version has an immutability trigger');
select has_trigger('api', 'route_version_stops', 'route_version_stops_guard_published', 'published composition has an immutability trigger');

set local role authenticated;
select set_config('request.jwt.claim.sub', :'seller_a_id', true);
select is(api.get_my_route_for_date('2099-09-15') ->> 'availability', 'available', 'seller loads its published route for the date');
select is(api.get_route(:'route_id'::uuid) ->> 'routeId', :'route_id', 'seller reads its published route by id');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', :'seller_b_id', true);
select throws_ok(
  format('select api.get_route(%L::uuid)', :'route_id'),
  'P0001', 'NOT_FOUND', 'foreign route is hidden from another seller'
);
select is(api.get_my_route_for_date('2099-09-15') ->> 'availability', 'empty', 'seller without a route receives a stable empty state');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_a_id', true);
select is(api.get_route(:'route_id'::uuid) ->> 'routeId', :'route_id', 'manager reads a published route inside its scope');
select throws_ok(
  $$select api.get_my_route_for_date('2099-09-15')$$,
  'P0001', 'FORBIDDEN', 'manager cannot use the seller self shortcut'
);
reset role;

do $grant_route_executor$
begin
  execute pg_catalog.format('grant cirne_route_executor to %I with set true granted by current_user', current_user);
end
$grant_route_executor$;
set local role cirne_route_executor;
savepoint before_supersede_check;
select lives_ok(
  format(
    'update api.route_versions set status = ''superseded'', superseded_at = ''2099-09-15T13:00:00Z'' where id = %L::uuid',
    :'route_version_id'
  ),
  'published version can transition to superseded without rewriting content'
);
select throws_ok(
  format(
    'update api.route_versions set seller_context_snapshot = ''{}''::jsonb where id = %L::uuid',
    :'route_version_id'
  ),
  'P0001', 'VERSION_CONFLICT', 'superseded version content remains immutable'
);
select throws_ok(
  format(
    'update api.route_version_stops set priority = 2 where route_version_id = %L::uuid',
    :'route_version_id'
  ),
  'P0001', 'VERSION_CONFLICT', 'superseded route composition remains immutable'
);
rollback to savepoint before_supersede_check;
reset role;
do $revoke_route_executor$
begin
  execute pg_catalog.format('revoke cirne_route_executor from %I granted by current_user', current_user);
end
$revoke_route_executor$;

set local role authenticated;
select set_config('request.jwt.claim.sub', :'blocked_id', true);
select throws_ok(
  $$select api.create_route_draft('{}'::jsonb)$$,
  'P0001', 'FORBIDDEN', 'blocked actor cannot create a route'
);
select throws_ok('select * from api.routes', '42501', null, 'authenticated cannot bypass route functions');
reset role;

select is((select count(*)::integer from private.audit_events where target_id = :'route_id'::uuid), 2, 'rejected operations do not create false audit events');

select * from finish();
rollback;
