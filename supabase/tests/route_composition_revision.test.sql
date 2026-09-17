begin;

select plan(49);

select has_function(
  'api', 'change_route_composition', array['uuid', 'jsonb', 'uuid', 'text'],
  'composition revision wrapper exists'
);
select has_column('api', 'route_versions', 'change_reason', 'route version stores the normalized reason');
select has_column('api', 'route_versions', 'change_summary', 'route version stores the composition diff');
select ok(
  has_function_privilege('authenticated', 'api.change_route_composition(uuid,jsonb,uuid,text)', 'EXECUTE'),
  'authenticated can call the narrow composition wrapper'
);
select ok(
  not has_function_privilege('anon', 'api.change_route_composition(uuid,jsonb,uuid,text)', 'EXECUTE'),
  'anon cannot revise route composition'
);

select id as seller_a_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'seller_a' \gset
select id as manager_a_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'manager_a' \gset

insert into api.clients (id, external_reference, name, address, portfolio_reference)
values
  ('10000000-0000-4000-8000-000000000001', 'SYN-001', 'Cliente Sintetico 01', 'Endereco sintetico 01', 'CARTEIRA-SINTETICA-A'),
  ('10000000-0000-4000-8000-000000000002', 'SYN-002', 'Cliente Sintetico 02', 'Endereco sintetico 02', 'CARTEIRA-SINTETICA-A'),
  ('10000000-0000-4000-8000-000000000003', 'SYN-003', 'Cliente Sintetico 03', 'Endereco sintetico 03', 'CARTEIRA-SINTETICA-A')
on conflict (id) do update set status = 'active', archived_at = null, name = excluded.name;

set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_a_id', true);
select api.create_route_draft(jsonb_build_object(
  'schemaVersion', 1,
  'serviceDate', '2099-09-26',
  'sellerId', :'seller_a_id',
  'stops', jsonb_build_array(
    jsonb_build_object('clientId', '10000000-0000-4000-8000-000000000001', 'plannedOrder', 1, 'priority', 1),
    jsonb_build_object('clientId', '10000000-0000-4000-8000-000000000002', 'plannedOrder', 3, 'priority', 0)
  )
)) as initial_draft \gset
select (:'initial_draft')::jsonb ->> 'routeId' as route_id \gset
select (:'initial_draft')::jsonb ->> 'routeVersionId' as initial_version_id \gset
select api.publish_route(:'route_id'::uuid, 1) as initial_publication \gset
select is((:'initial_publication')::jsonb ->> 'status', 'published', 'initial route is published');
reset role;

select is((select lock_version from api.routes where id = :'route_id'::uuid), 2, 'initial publication advances the aggregate to version two');

do $route_owner$
begin
  execute pg_catalog.format('grant cirne_route_executor to %I with set true granted by current_user', current_user);
end
$route_owner$;
set local role cirne_route_executor;
update api.route_stop_executions execution_row
set status = 'completed', lock_version = 2
from api.route_version_stops stop_row
where execution_row.route_version_stop_id = stop_row.id
  and stop_row.route_version_id = :'initial_version_id'::uuid
  and stop_row.client_id = '10000000-0000-4000-8000-000000000002';
reset role;
do $route_owner$
begin
  execute pg_catalog.format('revoke cirne_route_executor from %I granted by current_user', current_user);
end
$route_owner$;
select is((
  select execution_row.status
  from api.route_stop_executions execution_row
  join api.route_version_stops stop_row on stop_row.id = execution_row.route_version_stop_id
  where stop_row.route_version_id = :'initial_version_id'::uuid
    and stop_row.client_id = '10000000-0000-4000-8000-000000000002'
), 'completed', 'fixture has operational work to preserve');

set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_a_id', true);
select api.change_route_composition(
  :'route_id'::uuid,
  jsonb_build_object(
    'schemaVersion', 1,
    'expectedVersion', 2,
    'reason', '  Redistribuicao   comercial  ',
    'stops', jsonb_build_array(
      jsonb_build_object('clientId', '10000000-0000-4000-8000-000000000002', 'plannedOrder', 1, 'priority', 0),
      jsonb_build_object('clientId', '10000000-0000-4000-8000-000000000003', 'plannedOrder', 2, 'priority', 1)
    )
  ),
  '60000000-0000-4000-8000-000000000101'::uuid,
  'cli'
) as revision \gset
select is((:'revision')::jsonb ->> 'changed', 'true', 'effective composition revision is reported');
select is((:'revision')::jsonb ->> 'versionNumber', '2', 'revision creates the next numeric version');
select is((:'revision')::jsonb ->> 'expectedVersion', '3', 'revision advances the aggregate once');
select is((:'revision')::jsonb ->> 'changeReason', 'Redistribuicao comercial', 'reason is normalized');
select is(
  (:'revision')::jsonb #> '{changeSummary,addedClientIds}',
  '["10000000-0000-4000-8000-000000000003"]'::jsonb,
  'diff identifies the added client'
);
select is(
  (:'revision')::jsonb #> '{changeSummary,removedClientIds}',
  '["10000000-0000-4000-8000-000000000001"]'::jsonb,
  'diff identifies the removed client'
);
select is(
  (:'revision')::jsonb #> '{changeSummary,retainedClientIds}',
  '["10000000-0000-4000-8000-000000000002"]'::jsonb,
  'diff identifies the retained client'
);
select (:'revision')::jsonb ->> 'routeVersionId' as revised_version_id \gset
reset role;

select is((select count(*)::integer from api.route_versions where id = :'revised_version_id'::uuid and status = 'draft'), 1, 'one successor draft is stored');
select is((select status from api.route_versions where id = :'initial_version_id'::uuid), 'published', 'current publication remains untouched before republish');
select is((select count(*)::integer from api.route_version_stops where route_version_id = :'initial_version_id'::uuid), 2, 'published composition remains intact');
select is((select count(*)::integer from private.audit_events where target_id = :'route_id'::uuid and action = 'route.composition.drafted'), 1, 'effective revision appends one audit');
select is((
  select jsonb_build_object('actorId', actor_id, 'origin', origin, 'reason', reason)
  from private.audit_events where target_id = :'route_id'::uuid and action = 'route.composition.drafted'
), jsonb_build_object('actorId', :'manager_a_id'::uuid, 'origin', 'cli', 'reason', 'Redistribuicao comercial'), 'audit derives actor and records origin and reason');

set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_a_id', true);
select api.change_route_composition(
  :'route_id'::uuid,
  jsonb_build_object(
    'schemaVersion', 1, 'expectedVersion', 2, 'reason', '  Redistribuicao   comercial  ',
    'stops', jsonb_build_array(
      jsonb_build_object('clientId', '10000000-0000-4000-8000-000000000002', 'plannedOrder', 1, 'priority', 0),
      jsonb_build_object('clientId', '10000000-0000-4000-8000-000000000003', 'plannedOrder', 2, 'priority', 1)
    )
  ),
  '60000000-0000-4000-8000-000000000101'::uuid,
  'cli'
) as replay \gset
select is((:'replay')::jsonb, (:'revision')::jsonb, 'same idempotency key replays the stored result');
reset role;
select is((select count(*)::integer from private.audit_events where target_id = :'route_id'::uuid and action = 'route.composition.drafted'), 1, 'idempotent replay does not duplicate audit');
select is((select lock_version from api.routes where id = :'route_id'::uuid), 3, 'idempotent replay does not advance the aggregate');

set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_a_id', true);
select api.change_route_composition(
  :'route_id'::uuid,
  jsonb_build_object(
    'schemaVersion', 1, 'expectedVersion', 3, 'reason', 'Redistribuicao comercial',
    'stops', jsonb_build_array(
      jsonb_build_object('clientId', '10000000-0000-4000-8000-000000000002', 'plannedOrder', 1, 'priority', 0),
      jsonb_build_object('clientId', '10000000-0000-4000-8000-000000000003', 'plannedOrder', 2, 'priority', 1)
    )
  ),
  '60000000-0000-4000-8000-000000000102'::uuid,
  'web'
) as no_op \gset
select is((:'no_op')::jsonb ->> 'changed', 'false', 'same draft composition and reason are a no-op');
select is((:'no_op')::jsonb ->> 'routeVersionId', :'revised_version_id', 'no-op reuses the successor draft');
reset role;
select is((select lock_version from api.routes where id = :'route_id'::uuid), 3, 'no-op does not advance the aggregate');
select is((select count(*)::integer from private.audit_events where target_id = :'route_id'::uuid and action = 'route.composition.drafted'), 1, 'no-op does not create false audit');

set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_a_id', true);
select throws_ok(
  format('select api.change_route_composition(%L::uuid, %L::jsonb, %L::uuid, ''cli'')',
    :'route_id',
    jsonb_build_object(
      'schemaVersion', 1, 'expectedVersion', 3, 'reason', 'Duplicada',
      'stops', jsonb_build_array(
        jsonb_build_object('clientId', '10000000-0000-4000-8000-000000000002', 'plannedOrder', 1, 'priority', 0),
        jsonb_build_object('clientId', '10000000-0000-4000-8000-000000000002', 'plannedOrder', 2, 'priority', 1)
      )
    ), '60000000-0000-4000-8000-000000000103'),
  'P0001', 'VALIDATION_FAILED', 'duplicate client is rejected atomically'
);
reset role;
select is((select lock_version from api.routes where id = :'route_id'::uuid), 3, 'invalid revision leaves the aggregate unchanged');

set local role authenticated;
select set_config('request.jwt.claim.sub', :'seller_a_id', true);
select throws_ok(
  format('select api.change_route_composition(%L::uuid, %L::jsonb, %L::uuid, ''web'')',
    :'route_id',
    jsonb_build_object('schemaVersion', 1, 'expectedVersion', 3, 'reason', 'Sem autoridade',
      'stops', jsonb_build_array(jsonb_build_object(
        'clientId', '10000000-0000-4000-8000-000000000002', 'plannedOrder', 1, 'priority', 0))),
    '60000000-0000-4000-8000-000000000104'),
  'P0001', 'FORBIDDEN', 'seller cannot revise route composition'
);
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_a_id', true);
select throws_ok(
  format('select api.change_route_composition(%L::uuid, %L::jsonb, %L::uuid, ''cli'')',
    :'route_id',
    jsonb_build_object('schemaVersion', 1, 'expectedVersion', 2, 'reason', 'Versao obsoleta',
      'stops', jsonb_build_array(jsonb_build_object(
        'clientId', '10000000-0000-4000-8000-000000000002', 'plannedOrder', 1, 'priority', 0))),
    '60000000-0000-4000-8000-000000000105'),
  'P0001', 'VERSION_CONFLICT', 'stale aggregate version is rejected'
);
select api.publish_route(:'route_id'::uuid, 3) as successor_publication \gset
select is((:'successor_publication')::jsonb ->> 'versionNumber', '2', 'successor publication advances the route version');
select is((:'successor_publication')::jsonb ->> 'expectedVersion', '4', 'successor publication advances the aggregate once');
reset role;

select is((
  select jsonb_agg(jsonb_build_object('version', version_number, 'status', status) order by version_number)
  from api.route_versions where route_id = :'route_id'::uuid
), '[{"status":"superseded","version":1},{"status":"published","version":2}]'::jsonb, 'publication supersedes exactly the prior version');
select is((select count(*)::integer from api.route_stop_executions where route_version_id = :'initial_version_id'::uuid), 2, 'old executions remain stored');
select is((select count(*)::integer from api.route_stop_executions where route_version_id = :'revised_version_id'::uuid), 2, 'successor receives one execution per stop');
select is((
  select execution_row.status from api.route_stop_executions execution_row
  join api.route_version_stops stop_row on stop_row.id = execution_row.route_version_stop_id
  where stop_row.route_version_id = :'revised_version_id'::uuid
    and stop_row.client_id = '10000000-0000-4000-8000-000000000002'
), 'completed', 'retained client preserves operational status');
select is((
  select execution_row.status from api.route_stop_executions execution_row
  join api.route_version_stops stop_row on stop_row.id = execution_row.route_version_stop_id
  where stop_row.route_version_id = :'revised_version_id'::uuid
    and stop_row.client_id = '10000000-0000-4000-8000-000000000003'
), 'pending', 'added client starts pending');
select is((select count(*)::integer from api.route_version_stops where route_version_id = :'revised_version_id'::uuid and client_id = '10000000-0000-4000-8000-000000000001'), 0, 'removed client is absent only from the successor');

set local role authenticated;
select set_config('request.jwt.claim.sub', :'seller_a_id', true);
select is(api.get_route(:'route_id'::uuid) ->> 'schemaVersion', '3', 'seller reads the v3 canonical contract');
select is(api.get_route(:'route_id'::uuid) ->> 'versionNumber', '2', 'seller reads only the current route version');
select is(api.get_route(:'route_id'::uuid) #>> '{compositionChange,reason}', 'Redistribuicao comercial', 'canonical route exposes the change reason');
select is(api.get_my_route_for_date('2099-09-26') #>> '{route,routeVersionId}', :'revised_version_id', 'today reader returns the successor after publication');
reset role;

do $route_owner$
begin
  execute pg_catalog.format('grant cirne_route_executor to %I with set true granted by current_user', current_user);
end
$route_owner$;
set local role cirne_route_executor;
select throws_ok(
  format('update api.route_version_stops set priority = 9 where route_version_id = %L::uuid', :'initial_version_id'),
  'P0001', 'VERSION_CONFLICT', 'superseded composition remains immutable'
);
reset role;
do $route_owner$
begin
  execute pg_catalog.format('revoke cirne_route_executor from %I granted by current_user', current_user);
end
$route_owner$;

select is((select change_reason from api.route_versions where id = :'initial_version_id'::uuid), null, 'old version remains free of successor metadata');
select is((select count(*)::integer from private.audit_events where target_id = :'route_id'::uuid and action = 'route.published'), 2, 'each publication has one audit event');
select is((
  select after_data -> 'addedClientIds' from private.audit_events
  where target_id = :'route_id'::uuid and action = 'route.composition.drafted'
), '["10000000-0000-4000-8000-000000000003"]'::jsonb, 'composition audit stores the minimal added-client diff');

do $audit_owner$
begin
  execute pg_catalog.format('grant cirne_sync_executor to %I with set true granted by current_user', current_user);
end
$audit_owner$;
set local role cirne_sync_executor;
revoke insert on table private.audit_events from cirne_route_executor;
reset role;
do $audit_owner$
begin
  execute pg_catalog.format('revoke cirne_sync_executor from %I granted by current_user', current_user);
end
$audit_owner$;

set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_a_id', true);
select throws_ok(
  format('select api.change_route_composition(%L::uuid, %L::jsonb, %L::uuid, ''cli'')',
    :'route_id',
    jsonb_build_object(
      'schemaVersion', 1, 'expectedVersion', 4, 'reason', 'Falha de auditoria injetada',
      'stops', jsonb_build_array(
        jsonb_build_object('clientId', '10000000-0000-4000-8000-000000000001', 'plannedOrder', 1, 'priority', 0),
        jsonb_build_object('clientId', '10000000-0000-4000-8000-000000000003', 'plannedOrder', 2, 'priority', 1)
      )
    ), '60000000-0000-4000-8000-000000000106'),
  '42501', 'permission denied for table audit_events', 'audit failure aborts the composition command'
);
reset role;
select is((select lock_version from api.routes where id = :'route_id'::uuid), 4, 'audit failure leaves the aggregate unchanged');

do $audit_owner$
begin
  execute pg_catalog.format('grant cirne_sync_executor to %I with set true granted by current_user', current_user);
end
$audit_owner$;
set local role cirne_sync_executor;
grant insert on table private.audit_events to cirne_route_executor;
reset role;
do $audit_owner$
begin
  execute pg_catalog.format('revoke cirne_sync_executor from %I granted by current_user', current_user);
end
$audit_owner$;

select * from finish();
rollback;
