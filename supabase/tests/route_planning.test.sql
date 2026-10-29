begin;

select plan(32);

select has_function('api', 'get_route_planning', array['date','uuid'], 'planning lookup exists');
select has_function('api', 'update_route_draft', array['uuid','jsonb','uuid','text'], 'draft update exists');
select has_function('api', 'list_management_clients', array['text','integer','integer','uuid'], 'seller-filtered client listing exists');
select ok(has_function_privilege('authenticated', 'api.get_route_planning(date,uuid)', 'EXECUTE'), 'authenticated can query planning');
select ok(not has_function_privilege('anon', 'api.get_route_planning(date,uuid)', 'EXECUTE'), 'anon cannot query planning');
select ok(has_function_privilege('authenticated', 'api.update_route_draft(uuid,jsonb,uuid,text)', 'EXECUTE'), 'authenticated can update a scoped draft');
select ok(exists(select 1 from pg_catalog.pg_policy where polrelid = 'api.roles'::regclass and polname = 'roles_route_planner_read'), 'route executor has the narrow role-directory policy');
select ok(exists(select 1 from pg_catalog.pg_policy where polrelid = 'api.user_role_assignments'::regclass and polname = 'user_role_assignments_route_planner_read'), 'route executor has the narrow seller-assignment policy');

select id as seller_a_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'seller_a' \gset
select id as seller_b_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'seller_b' \gset
select id as manager_a_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'manager_a' \gset

set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_a_id', true);
select is(api.get_route_planning('2099-10-29', :'seller_a_id') ->> 'availability', 'empty', 'planning begins empty');
select is(api.get_route_planning('2099-10-29', :'seller_a_id') ->> 'sellerId', :'seller_a_id', 'empty state identifies the selected seller');
select is(jsonb_array_length(api.list_client_management_sellers()), 1, 'manager receives the active seller inside its scope');
reset role;

insert into api.clients (id, external_reference, name, address, portfolio_reference)
values
  ('48000000-0000-4000-8000-000000000001', 'PLAN-001', 'Cliente Planejado A', 'Endereco A', 'PLAN-A'),
  ('48000000-0000-4000-8000-000000000002', 'PLAN-002', 'Cliente Planejado B', 'Endereco B', 'PLAN-A'),
  ('48000000-0000-4000-8000-000000000003', 'PLAN-003', 'Cliente Fora da Carteira', 'Endereco C', 'PLAN-B');
insert into api.client_seller_scopes (client_id, seller_id, assigned_by)
values
  ('48000000-0000-4000-8000-000000000001', :'seller_a_id', :'manager_a_id'),
  ('48000000-0000-4000-8000-000000000002', :'seller_a_id', :'manager_a_id'),
  ('48000000-0000-4000-8000-000000000003', :'seller_b_id', :'manager_a_id');

set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_a_id', true);
select is((api.list_management_clients('PLAN-', 1, 25, :'seller_a_id') #>> '{pagination,totalCount}')::integer, 2, 'seller filter paginates only the selected portfolio');
select is((api.list_management_clients('PLAN-', 1, 25, :'seller_a_id') #>> '{clients,0,sellerId}'), :'seller_a_id', 'filtered rows identify the selected seller');

select api.create_route_draft(jsonb_build_object(
  'schemaVersion', 1, 'serviceDate', '2099-10-29', 'sellerId', :'seller_a_id',
  'stops', jsonb_build_array(
    jsonb_build_object('clientId', '48000000-0000-4000-8000-000000000001', 'plannedOrder', 1, 'priority', 0),
    jsonb_build_object('clientId', '48000000-0000-4000-8000-000000000002', 'plannedOrder', 2, 'priority', 1)
  )
)) as initial_draft \gset
select (:'initial_draft')::jsonb ->> 'routeId' as route_id \gset
select is(api.get_route_planning('2099-10-29', :'seller_a_id') #>> '{route,state}', 'initial_draft', 'created route is exposed as an initial draft');
select is(jsonb_array_length(api.get_route_planning('2099-10-29', :'seller_a_id') #> '{route,stops}'), 2, 'planning returns the persisted composition');

select api.update_route_draft(
  :'route_id',
  jsonb_build_object(
    'schemaVersion', 1, 'expectedVersion', 1,
    'stops', jsonb_build_array(
      jsonb_build_object('clientId', '48000000-0000-4000-8000-000000000002', 'plannedOrder', 1, 'priority', 2),
      jsonb_build_object('clientId', '48000000-0000-4000-8000-000000000001', 'plannedOrder', 2, 'priority', 0)
    )
  ),
  '48000000-0000-4000-8000-000000000101', 'web'
) as updated_draft \gset
select is((:'updated_draft')::jsonb ->> 'expectedVersion', '2', 'changed draft advances the aggregate version');
select is((:'updated_draft')::jsonb #>> '{stops,0,clientId}', '48000000-0000-4000-8000-000000000002', 'changed draft persists the accessible order');
reset role;
select is((select count(*)::integer from private.audit_events where target_id = :'route_id' and action = 'route.draft.updated'), 1, 'draft edit is audited once');
set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_a_id', true);
select is(api.update_route_draft(
  :'route_id',
  jsonb_build_object(
    'schemaVersion', 1, 'expectedVersion', 1,
    'stops', jsonb_build_array(
      jsonb_build_object('clientId', '48000000-0000-4000-8000-000000000002', 'plannedOrder', 1, 'priority', 2),
      jsonb_build_object('clientId', '48000000-0000-4000-8000-000000000001', 'plannedOrder', 2, 'priority', 0)
    )
  ),
  '48000000-0000-4000-8000-000000000101', 'web'
), (:'updated_draft')::jsonb, 'same idempotency key and payload replay the original result');
reset role;
select is((select count(*)::integer from private.audit_events where target_id = :'route_id' and action = 'route.draft.updated'), 1, 'replay creates no duplicate audit');
set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_a_id', true);
select api.create_route_draft(jsonb_build_object(
  'schemaVersion', 1, 'serviceDate', '2099-10-31', 'sellerId', :'seller_a_id',
  'stops', jsonb_build_array(
    jsonb_build_object('clientId', '48000000-0000-4000-8000-000000000002', 'plannedOrder', 1, 'priority', 2),
    jsonb_build_object('clientId', '48000000-0000-4000-8000-000000000001', 'plannedOrder', 2, 'priority', 0)
  )
)) as other_draft \gset
select throws_ok(
  format('select api.update_route_draft(%L, %L::jsonb, %L, ''web'')',
    (:'other_draft')::jsonb ->> 'routeId',
    jsonb_build_object('schemaVersion',1,'expectedVersion',1,'stops',jsonb_build_array(
      jsonb_build_object('clientId','48000000-0000-4000-8000-000000000002','plannedOrder',1,'priority',2),
      jsonb_build_object('clientId','48000000-0000-4000-8000-000000000001','plannedOrder',2,'priority',0))),
    '48000000-0000-4000-8000-000000000101'),
  'P0001', 'IDEMPOTENCY_KEY_REUSED', 'idempotency replay cannot cross route aggregates');
select throws_ok(
  format('select api.update_route_draft(%L, %L::jsonb, %L, ''web'')', :'route_id',
    jsonb_build_object('schemaVersion',1,'expectedVersion',2,'stops',jsonb_build_array(
      jsonb_build_object('clientId','48000000-0000-4000-8000-000000000001','plannedOrder',1,'priority',0))),
    '48000000-0000-4000-8000-000000000101'),
  'P0001', 'IDEMPOTENCY_KEY_REUSED', 'reusing a key with another payload is rejected');
select throws_ok(
  format('select api.update_route_draft(%L, %L::jsonb, %L, ''web'')', :'route_id',
    jsonb_build_object('schemaVersion',1,'expectedVersion',1,'stops',jsonb_build_array(
      jsonb_build_object('clientId','48000000-0000-4000-8000-000000000001','plannedOrder',1,'priority',0))),
    '48000000-0000-4000-8000-000000000102'),
  'P0001', 'VERSION_CONFLICT', 'stale draft version is rejected');
select throws_ok(
  format('select api.create_route_draft(%L::jsonb)', jsonb_build_object(
    'schemaVersion',1,'serviceDate','2099-10-30','sellerId',:'seller_a_id','stops',jsonb_build_array(
      jsonb_build_object('clientId','48000000-0000-4000-8000-000000000003','plannedOrder',1,'priority',0)))),
  'P0001', 'VALIDATION_FAILED', 'client outside the selected seller portfolio is rejected');

select api.publish_route(:'route_id', 2) as publication \gset
select is((:'publication')::jsonb ->> 'status', 'published', 'reviewed initial draft is published');
select is(api.get_route_planning('2099-10-29', :'seller_a_id') #>> '{route,state}', 'published', 'planning reports the published state');
select is(api.get_route_planning('2099-10-29', :'seller_a_id') #>> '{route,publishedVersionNumber}', '1', 'planning identifies the current published version');
select is(api.get_route_planning('2099-10-29', :'seller_a_id') #>> '{route,stops,0,client,name}', 'Cliente Planejado B', 'published planning reads the immutable client snapshot');

select api.change_route_composition(
  :'route_id',
  jsonb_build_object(
    'schemaVersion', 1, 'expectedVersion', 3, 'reason', 'Ajuste comercial do dia',
    'stops', jsonb_build_array(
      jsonb_build_object('clientId', '48000000-0000-4000-8000-000000000001', 'plannedOrder', 1, 'priority', 3)
    )
  ),
  '48000000-0000-4000-8000-000000000103', 'web'
) as successor \gset
select is((:'successor')::jsonb ->> 'versionNumber', '2', 'post-publication change creates the successor version');
select is(api.get_route_planning('2099-10-29', :'seller_a_id') #>> '{route,state}', 'successor_draft', 'planning exposes the successor draft');
select is(api.get_route_planning('2099-10-29', :'seller_a_id') #>> '{route,changeReason}', 'Ajuste comercial do dia', 'successor reason remains visible for review');
select throws_ok(
  format('select api.update_route_draft(%L, %L::jsonb, %L, ''web'')', :'route_id',
    jsonb_build_object('schemaVersion',1,'expectedVersion',4,'stops',jsonb_build_array(
      jsonb_build_object('clientId','48000000-0000-4000-8000-000000000001','plannedOrder',1,'priority',0))),
    '48000000-0000-4000-8000-000000000104'),
  'P0001', 'VERSION_CONFLICT', 'initial-draft updater cannot mutate a published route');
reset role;

select * from finish();
rollback;
