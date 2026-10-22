begin;

select plan(31);

select has_view('api', 'management_day_v', 'canonical management projection exists');
select has_function('api', 'get_management_day', array['date', 'text'], 'narrow management reader exists');
select has_function('api', 'observe_sync_failure', array['uuid', 'uuid', 'text', 'boolean', 'timestamp with time zone'], 'sanitized sync observation exists');
select has_function('api', 'resolve_sync_failure', array['uuid', 'uuid'], 'recoverable sync resolution exists');
select ok(
  not (select rolcanlogin or rolbypassrls or rolsuper from pg_catalog.pg_roles where rolname = 'cirne_management_executor'),
  'management executor cannot login or bypass RLS'
);
select ok(not has_table_privilege('authenticated', 'api.management_day_v', 'SELECT'), 'authenticated cannot select the projection directly');
select ok(not has_table_privilege('authenticated', 'private.sync_failure_observations', 'SELECT'), 'authenticated cannot read sync observations directly');
select ok(has_function_privilege('authenticated', 'api.get_management_day(date,text)', 'EXECUTE'), 'authenticated can call the authorized reader');
select ok(not has_function_privilege('anon', 'api.get_management_day(date,text)', 'EXECUTE'), 'anon cannot call the management reader');

select id as seller_a_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'seller_a' \gset
select id as seller_b_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'seller_b' \gset
select id as manager_a_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'manager_a' \gset
select id as admin_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'administrator' \gset
select id as blocked_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'blocked' \gset

set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_a_id', true);
select is(api.get_management_day('2099-10-20', 'America/Recife') ->> 'availability', 'empty', 'scoped manager receives an empty state');
reset role;

insert into api.clients (id, external_reference, name, address, portfolio_reference)
values
  ('41000000-0000-4000-8000-000000000001', 'MGT-001', 'Cliente Atual A', 'Endereco sintetico A', 'MGT'),
  ('41000000-0000-4000-8000-000000000002', 'MGT-002', 'Cliente Nao Visitado', 'Endereco sintetico B', 'MGT'),
  ('41000000-0000-4000-8000-000000000003', 'MGT-003', 'Cliente Atual C', 'Endereco sintetico C', 'MGT'),
  ('41000000-0000-4000-8000-000000000004', 'MGT-004', 'Cliente Novo D', 'Endereco sintetico D', 'MGT')
on conflict (id) do update set status = 'active', archived_at = null;

set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_a_id', true);
select api.create_route_draft(jsonb_build_object(
  'schemaVersion', 1, 'serviceDate', '2099-10-20', 'sellerId', :'seller_a_id',
  'stops', jsonb_build_array(
    jsonb_build_object('clientId', '41000000-0000-4000-8000-000000000001', 'plannedOrder', 1, 'priority', 0),
    jsonb_build_object('clientId', '41000000-0000-4000-8000-000000000002', 'plannedOrder', 2, 'priority', 0),
    jsonb_build_object('clientId', '41000000-0000-4000-8000-000000000003', 'plannedOrder', 3, 'priority', 0)
  )
)) as initial_draft \gset
select (:'initial_draft')::jsonb ->> 'routeId' as route_id \gset
select (:'initial_draft')::jsonb ->> 'routeVersionId' as initial_version_id \gset
select api.publish_route(:'route_id'::uuid, 1) as initial_publication \gset
reset role;

do $route_owner$
begin
  execute pg_catalog.format('grant cirne_route_executor to %I with set true granted by current_user', current_user);
end
$route_owner$;
set local role cirne_route_executor;
update api.route_stop_executions execution_row set status = 'completed', lock_version = 2
from api.route_version_stops stop_row
where execution_row.route_version_stop_id = stop_row.id
  and stop_row.route_version_id = :'initial_version_id'::uuid
  and stop_row.client_id = '41000000-0000-4000-8000-000000000001';
update api.route_stop_executions execution_row
set status = 'not_visited', non_visit_reason_id = '41000000-0000-4000-8000-000000000099', lock_version = 2
from api.route_version_stops stop_row
where execution_row.route_version_stop_id = stop_row.id
  and stop_row.route_version_id = :'initial_version_id'::uuid
  and stop_row.client_id = '41000000-0000-4000-8000-000000000002';
reset role;
do $route_owner$
begin
  execute pg_catalog.format('revoke cirne_route_executor from %I granted by current_user', current_user);
end
$route_owner$;

set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_a_id', true);
select api.change_route_composition(
  :'route_id'::uuid,
  jsonb_build_object(
    'schemaVersion', 1, 'expectedVersion', 2, 'reason', 'Revisao sintetica gerencial',
    'stops', jsonb_build_array(
      jsonb_build_object('clientId', '41000000-0000-4000-8000-000000000002', 'plannedOrder', 1, 'priority', 0),
      jsonb_build_object('clientId', '41000000-0000-4000-8000-000000000003', 'plannedOrder', 2, 'priority', 0),
      jsonb_build_object('clientId', '41000000-0000-4000-8000-000000000004', 'plannedOrder', 3, 'priority', 0)
    )
  ),
  '41000000-0000-4000-8000-000000000050'::uuid,
  'cli'
) as revision \gset
select (:'revision')::jsonb ->> 'routeVersionId' as revised_version_id \gset
select api.publish_route(:'route_id'::uuid, 3) as revised_publication \gset
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', :'seller_a_id', true);
select lives_ok($$select api.observe_sync_failure(
  '41000000-0000-4000-8000-000000000060'::uuid,
  '41000000-0000-4000-8000-000000000061'::uuid,
  'DEPENDENCY_UNAVAILABLE', true, '2099-10-20T12:00:00Z'
)$$, 'seller records a recoverable server-known failure');
select lives_ok($$select api.observe_sync_failure(
  '41000000-0000-4000-8000-000000000060'::uuid,
  '41000000-0000-4000-8000-000000000062'::uuid,
  'VERSION_CONFLICT', false, '2099-10-20T12:05:00Z'
)$$, 'seller records an action-required server-known failure');
reset role;

-- This published route belongs to a seller outside the manager scope and must never enter the result.
do $route_owner$
begin
  execute pg_catalog.format('grant cirne_route_executor to %I with set true granted by current_user', current_user);
end
$route_owner$;
set local role cirne_route_executor;
insert into api.routes (id, service_date, seller_id, status, created_by)
values ('41000000-0000-4000-8000-000000000070', '2099-10-20', :'seller_b_id', 'draft', :'manager_a_id');
insert into api.route_versions (id, route_id, version_number, status, created_by)
values ('41000000-0000-4000-8000-000000000071', '41000000-0000-4000-8000-000000000070', 1, 'draft', :'manager_a_id');
insert into api.route_version_stops (id, route_version_id, client_id, planned_order, priority, client_context_snapshot)
values ('41000000-0000-4000-8000-000000000072', '41000000-0000-4000-8000-000000000071',
  '41000000-0000-4000-8000-000000000004', 1, 0,
  jsonb_build_object('id', '41000000-0000-4000-8000-000000000004', 'name', 'Cliente Fora do Escopo'));
update api.route_versions set status = 'published',
  seller_context_snapshot = jsonb_build_object('id', :'seller_b_id'::uuid, 'displayName', 'Vendedor Fora do Escopo'),
  published_by = :'manager_a_id', published_at = statement_timestamp()
where id = '41000000-0000-4000-8000-000000000071';
update api.routes set status = 'published' where id = '41000000-0000-4000-8000-000000000070';
insert into api.route_stop_executions (route_version_id, route_version_stop_id, execution_order)
values ('41000000-0000-4000-8000-000000000071', '41000000-0000-4000-8000-000000000072', 1);
reset role;
do $route_owner$
begin
  execute pg_catalog.format('revoke cirne_route_executor from %I granted by current_user', current_user);
end
$route_owner$;

set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_a_id', true);
select api.get_management_day('2099-10-20', 'America/Recife') as management_result \gset
select is((:'management_result')::jsonb ->> 'availability', 'available', 'manager receives the available state');
select is(jsonb_array_length((:'management_result')::jsonb -> 'routes'), 1, 'only the scoped seller route is returned');
select is((:'management_result')::jsonb #>> '{totals,planned}', '3', 'only current composition contributes to planned');
select is((:'management_result')::jsonb #>> '{totals,pending}', '2', 'new and retained pending stops are counted once');
select is((:'management_result')::jsonb #>> '{totals,notVisited}', '1', 'retained non-visit remains distinct');
select is((:'management_result')::jsonb #>> '{totals,completed}', '0', 'removed completed work does not inflate current planned totals');
select is(jsonb_array_length((:'management_result')::jsonb #> '{routes,0,historicalExecutions}'), 1, 'removed completed work appears once as historical exception');
select is((:'management_result')::jsonb #>> '{routes,0,historicalExecutions,0,status}', 'completed', 'historical exception preserves its status');
select is((:'management_result')::jsonb #>> '{routes,0,nonVisits,0,reasonId}', '41000000-0000-4000-8000-000000000099', 'non-visit reason reference is exposed');
select is((:'management_result')::jsonb #>> '{sync,pending}', '1', 'recoverable server-known failure is a pending sync');
select is((:'management_result')::jsonb #>> '{sync,errors}', '1', 'action-required server-known failure is an error');
select ok((:'management_result')::text !~* '(payload|token|latitude|longitude|photo)', 'response redacts sensitive sync and visit details');
select ok((:'management_result')::jsonb ->> 'serverVisibilityNote' like '%apenas no aparelho não são visíveis%', 'response states the local outbox visibility limit');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', :'seller_a_id', true);
select lives_ok($$select api.resolve_sync_failure(
  '41000000-0000-4000-8000-000000000060'::uuid,
  '41000000-0000-4000-8000-000000000061'::uuid
)$$, 'confirmation clears the matching recoverable failure');
select set_config('request.jwt.claim.sub', :'manager_a_id', true);
select api.get_management_day('2099-10-20', 'America/Recife') as resolved_management_result \gset
select is((:'resolved_management_result')::jsonb #>> '{sync,pending}', '0', 'confirmed recoverable failure is no longer pending');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', :'seller_a_id', true);
select throws_ok($$select api.get_management_day('2099-10-20', 'America/Recife')$$,
  'P0001', 'FORBIDDEN', 'seller cannot query management day directly');
select set_config('request.jwt.claim.sub', :'admin_id', true);
select throws_ok($$select api.get_management_day('2099-10-20', 'America/Recife')$$,
  'P0001', 'FORBIDDEN', 'administrator has no implicit commercial access');
select set_config('request.jwt.claim.sub', :'blocked_id', true);
select throws_ok($$select api.get_management_day('2099-10-20', 'America/Recife')$$,
  'P0001', 'FORBIDDEN', 'blocked actor cannot query management day');
reset role;

update api.user_seller_scopes set revoked_at = statement_timestamp()
where manager_user_id = :'manager_a_id'::uuid and seller_user_id = :'seller_a_id'::uuid and revoked_at is null;
set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_a_id', true);
select throws_ok($$select api.get_management_day('2099-10-20', 'America/Recife')$$,
  'P0001', 'FORBIDDEN', 'manager without an active scope is denied');
reset role;

select * from finish();
rollback;
