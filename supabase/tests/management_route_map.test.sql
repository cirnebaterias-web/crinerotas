begin;

select plan(19);

select has_function('api', 'get_management_route_map', array['date'], 'narrow management map reader exists');
select ok(has_function_privilege('authenticated', 'api.get_management_route_map(date)', 'EXECUTE'),
  'authenticated can call the authorized map reader');
select ok(not has_function_privilege('anon', 'api.get_management_route_map(date)', 'EXECUTE'),
  'anon cannot call the management map reader');

select id as seller_a_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'seller_a' \gset
select id as seller_b_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'seller_b' \gset
select id as manager_a_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'manager_a' \gset
select id as admin_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'administrator' \gset
select id as blocked_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'blocked' \gset

set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_a_id', true);
select is(api.get_management_route_map('2099-11-01') ->> 'availability', 'empty',
  'scoped manager receives an empty map state');
reset role;

insert into api.clients (id, external_reference, name, address, portfolio_reference, location)
values
  ('42000000-0000-4000-8000-000000000001', 'MAP-001', 'Cliente Mapa A', 'Endereco snapshot A', 'MAP',
    extensions.st_setsrid(extensions.st_makepoint(-35.2100, -5.7900), 4326)::extensions.geography),
  ('42000000-0000-4000-8000-000000000002', 'MAP-002', 'Cliente Mapa B', 'Endereco snapshot B', 'MAP', null)
on conflict (id) do update set status = 'active', archived_at = null;

insert into api.client_seller_scopes (client_id, seller_id, assigned_by)
values
  ('42000000-0000-4000-8000-000000000001', :'seller_a_id', :'manager_a_id'),
  ('42000000-0000-4000-8000-000000000002', :'seller_a_id', :'manager_a_id')
on conflict do nothing;

set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_a_id', true);
select api.create_route_draft(jsonb_build_object(
  'schemaVersion', 1, 'serviceDate', '2099-11-01', 'sellerId', :'seller_a_id',
  'stops', jsonb_build_array(
    jsonb_build_object('clientId', '42000000-0000-4000-8000-000000000001', 'plannedOrder', 1, 'priority', 1),
    jsonb_build_object('clientId', '42000000-0000-4000-8000-000000000002', 'plannedOrder', 2, 'priority', 0)
  )
)) as map_draft \gset
select (:'map_draft')::jsonb ->> 'routeId' as map_route_id \gset
select api.publish_route(:'map_route_id'::uuid, 1) as map_publication \gset
select api.change_route_composition(
  :'map_route_id'::uuid,
  jsonb_build_object(
    'schemaVersion', 1, 'expectedVersion', 2, 'reason', 'Rascunho nao publicado para prova do mapa',
    'stops', jsonb_build_array(
      jsonb_build_object('clientId', '42000000-0000-4000-8000-000000000002', 'plannedOrder', 1, 'priority', 0)
    )
  ),
  '42000000-0000-4000-8000-000000000010'::uuid,
  'cli'
) as successor_draft \gset
reset role;

do $route_owner$
begin
  execute pg_catalog.format('grant cirne_route_executor to %I with set true granted by current_user', current_user);
end
$route_owner$;
set local role cirne_route_executor;

update api.clients set location =
  extensions.st_setsrid(extensions.st_makepoint(-36.0000, -6.0000), 4326)::extensions.geography
where id = '42000000-0000-4000-8000-000000000001';

insert into api.routes (id, service_date, seller_id, status, created_by)
values ('42000000-0000-4000-8000-000000000020', '2099-11-01', :'seller_b_id', 'draft', :'manager_a_id');
insert into api.route_versions (
  id, route_id, version_number, status, seller_context_snapshot, created_by, published_by, published_at
) values (
  '42000000-0000-4000-8000-000000000021', '42000000-0000-4000-8000-000000000020', 1, 'draft',
  null, :'manager_a_id', null, null
);
insert into api.route_version_stops (
  id, route_version_id, client_id, planned_order, priority, client_context_snapshot
) values (
  '42000000-0000-4000-8000-000000000022', '42000000-0000-4000-8000-000000000021',
  '42000000-0000-4000-8000-000000000001', 1, 0,
  jsonb_build_object('id', '42000000-0000-4000-8000-000000000001', 'name', 'Cliente Fora do Escopo',
    'address', 'Endereco fora do escopo', 'latitude', '-5.8', 'longitude', '-35.2')
);
insert into api.route_stop_executions (route_version_id, route_version_stop_id, execution_order)
values ('42000000-0000-4000-8000-000000000021', '42000000-0000-4000-8000-000000000022', 1);
update api.route_versions set status = 'published',
  seller_context_snapshot = jsonb_build_object('id', :'seller_b_id'::uuid, 'displayName', 'Vendedor Fora do Escopo'),
  published_by = :'manager_a_id', published_at = statement_timestamp()
where id = '42000000-0000-4000-8000-000000000021';
update api.routes set status = 'published' where id = '42000000-0000-4000-8000-000000000020';

reset role;
do $route_owner$
begin
  execute pg_catalog.format('revoke cirne_route_executor from %I granted by current_user', current_user);
end
$route_owner$;

set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_a_id', true);
select api.get_management_route_map('2099-11-01') as map_result \gset
select is((:'map_result')::jsonb ->> 'availability', 'available', 'map becomes available');
select is(jsonb_array_length((:'map_result')::jsonb -> 'routes'), 1, 'only the scoped seller route is returned');
select is(jsonb_array_length((:'map_result')::jsonb #> '{routes,0,stops}'), 2, 'published snapshot stops are returned');
select is((:'map_result')::jsonb #>> '{routes,0,versionNumber}', '1', 'unpublished successor does not replace the published version');
select is((:'map_result')::jsonb #>> '{routes,0,stops,0,location,latitude}', '-5.79',
  'published latitude snapshot is preserved');
select isnt((:'map_result')::jsonb #>> '{routes,0,stops,0,location,latitude}', '-6',
  'current client coordinate does not rewrite the snapshot');
select is((:'map_result')::jsonb #> '{routes,0,stops,1,location}', 'null'::jsonb,
  'client without a coordinate pair remains explicitly unpositioned');
select is((:'map_result')::jsonb #>> '{totals,positioned}', '1', 'positioned total is explicit');
select is((:'map_result')::jsonb #>> '{totals,unpositioned}', '1', 'unpositioned total is explicit');
select ok((:'map_result')::text !~* '"(gps|accuracy|distance|photo|payload|token)"[[:space:]]*:',
  'projection excludes observed location, evidence and payload data');
select throws_ok($$select api.get_management_route_map(null)$$,
  'P0001', 'VALIDATION_FAILED', 'null service date is rejected');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', :'seller_a_id', true);
select throws_ok($$select api.get_management_route_map('2099-11-01')$$,
  'P0001', 'FORBIDDEN', 'seller cannot query management map');
select set_config('request.jwt.claim.sub', :'admin_id', true);
select throws_ok($$select api.get_management_route_map('2099-11-01')$$,
  'P0001', 'FORBIDDEN', 'administrator has no implicit commercial map access');
select set_config('request.jwt.claim.sub', :'blocked_id', true);
select throws_ok($$select api.get_management_route_map('2099-11-01')$$,
  'P0001', 'FORBIDDEN', 'blocked actor cannot query management map');
reset role;

update api.user_seller_scopes set revoked_at = statement_timestamp()
where manager_user_id = :'manager_a_id'::uuid and seller_user_id = :'seller_a_id'::uuid and revoked_at is null;
set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_a_id', true);
select throws_ok($$select api.get_management_route_map('2099-11-01')$$,
  'P0001', 'FORBIDDEN', 'manager without active scope is denied');
reset role;

select * from finish();
rollback;
