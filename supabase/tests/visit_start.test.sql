begin;

select plan(68);

-- Existing synthetic visits from API/CLI/E2E runs must not require a destructive reset.
select count(*)::integer as initial_visits from api.visits \gset
select count(*)::integer as initial_locations from api.location_events \gset
select count(*)::integer as initial_audits from private.audit_events
where action = 'visit.started.v1' \gset

select has_table('api', 'parameter_sets', 'parameter sets exist');
select has_table('api', 'visits', 'visits exist');
select has_table('api', 'location_events', 'location events exist');
select has_function('api', 'start_visit', array['uuid', 'uuid', 'jsonb'], 'visit wrapper exists');
select has_function('api', 'sync_event', array['uuid', 'jsonb'], 'shared sync wrapper remains available');
select ok(has_function_privilege('authenticated', 'api.start_visit(uuid,uuid,jsonb)', 'EXECUTE'), 'authenticated can execute visit wrapper');
select ok(not has_function_privilege('anon', 'api.start_visit(uuid,uuid,jsonb)', 'EXECUTE'), 'anon cannot start visits');
select ok(not has_table_privilege('authenticated', 'api.visits', 'SELECT'), 'authenticated cannot read visits directly');
select ok(not has_table_privilege('authenticated', 'api.location_events', 'SELECT'), 'authenticated cannot read location directly');
select ok(not has_table_privilege('authenticated', 'api.parameter_sets', 'SELECT'), 'authenticated cannot read parameters directly');

select id as seller_a_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'seller_a' \gset
select id as seller_b_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'seller_b' \gset
select id as manager_a_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'manager_a' \gset
select id as administrator_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'administrator' \gset

update api.parameter_sets set status = 'retired' where status = 'published';
insert into api.parameter_sets (
  id, version, status, valid_from, published_at, published_by
) values (
  '90000000-0000-4000-8000-000000000099', 99, 'published',
  '2099-01-01T00:00:00Z', '2099-01-01T00:00:00Z', :'administrator_id'
) on conflict (id) do update set
  version = excluded.version,
  status = excluded.status,
  valid_from = excluded.valid_from,
  published_at = excluded.published_at,
  published_by = excluded.published_by;

insert into api.clients (id, external_reference, name, address, portfolio_reference)
values
  ('10000000-0000-4000-8000-000000000091', 'VIS-091', 'Cliente Visita 01', 'Endereco visita 01', 'CARTEIRA-VISITA'),
  ('10000000-0000-4000-8000-000000000092', 'VIS-092', 'Cliente Visita 02', 'Endereco visita 02', 'CARTEIRA-VISITA'),
  ('10000000-0000-4000-8000-000000000093', 'VIS-093', 'Cliente Retirado Offline', 'Endereco visita 03', 'CARTEIRA-VISITA')
on conflict (id) do update set name = excluded.name, address = excluded.address;

set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_a_id', true);
select api.create_route_draft(jsonb_build_object(
  'schemaVersion', 1,
  'serviceDate', '2099-09-17',
  'sellerId', :'seller_a_id',
  'stops', jsonb_build_array(
    jsonb_build_object('clientId', '10000000-0000-4000-8000-000000000091', 'plannedOrder', 1, 'priority', 2),
    jsonb_build_object('clientId', '10000000-0000-4000-8000-000000000092', 'plannedOrder', 2, 'priority', 0),
    jsonb_build_object('clientId', '10000000-0000-4000-8000-000000000093', 'plannedOrder', 3, 'priority', 0)
  )
)) as draft_result \gset
reset role;
select pass('manager creates the synthetic route prerequisite');

select (:'draft_result')::jsonb ->> 'routeId' as route_id \gset
select (:'draft_result')::jsonb ->> 'routeVersionId' as route_version_id \gset
select id as first_stop_id from api.route_version_stops
where route_version_id = :'route_version_id'::uuid and planned_order = 1 \gset
select id as second_stop_id from api.route_version_stops
where route_version_id = :'route_version_id'::uuid and planned_order = 2 \gset
select id as removed_stop_id from api.route_version_stops
where route_version_id = :'route_version_id'::uuid and planned_order = 3 \gset

set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_a_id', true);
select api.publish_route(:'route_id'::uuid, 1) as publication_result \gset
reset role;
select is((:'publication_result')::jsonb ->> 'status', 'published', 'route prerequisite is published');

-- Fail after the visit/location/execution writes. The exception subtransaction must undo all of them.
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
  format($sql$select api.start_visit(
    '22000000-0000-4000-8000-000000000001'::uuid,
    '77000000-0000-4000-8000-000000000001'::uuid,
    jsonb_build_object('schemaVersion', 1, 'offlineId', '55000000-0000-4000-8000-000000000001',
      'routeVersionStopId', %L, 'deviceStartedAt', '2099-09-17T12:00:00.000Z',
      'location', jsonb_build_object('latitude', '-7.115', 'longitude', '-34.864', 'accuracyM', '12.5', 'distanceM', '8')))$sql$,
    :'first_stop_id'),
  '42501', null, 'audit failure aborts the entire visit start'
);
reset role;
set local role cirne_sync_executor;
grant insert on private.audit_events to cirne_visit_executor;
reset role;
do $audit_owner$
begin
  execute pg_catalog.format('revoke cirne_sync_executor from %I granted by current_user', current_user);
end
$audit_owner$;
select is((select count(*)::integer from api.visits) - :initial_visits, 0, 'audit failure rolls back the visit');
select is((select count(*)::integer from api.location_events) - :initial_locations, 0, 'audit failure rolls back location');
select is((select count(*)::integer from private.audit_events where action = 'visit.started.v1') - :initial_audits, 0, 'failed audit leaves no audit fact');
select is((select status from api.route_stop_executions where route_version_stop_id = :'first_stop_id'::uuid), 'pending', 'audit failure restores pending execution');
select is((select lock_version from api.route_stop_executions where route_version_stop_id = :'first_stop_id'::uuid), 1, 'audit failure restores the execution version');
select is((select count(*)::integer from private.sync_events
  where actor_id = :'seller_a_id'::uuid and device_id = '22000000-0000-4000-8000-000000000001'
    and idempotency_key = '77000000-0000-4000-8000-000000000001'), 0, 'audit failure does not reserve or confirm the idempotency key');

set local role authenticated;
select set_config('request.jwt.claim.sub', :'seller_a_id', true);
select api.start_visit(
  '22000000-0000-4000-8000-000000000001',
  '77000000-0000-4000-8000-000000000001',
  jsonb_build_object(
    'schemaVersion', 1,
    'offlineId', '55000000-0000-4000-8000-000000000001',
    'routeVersionStopId', :'first_stop_id',
    'deviceStartedAt', '2099-09-17T12:00:00.000Z',
    'location', jsonb_build_object(
      'latitude', '-7.115', 'longitude', '-34.864', 'accuracyM', '12.5', 'distanceM', '8'
    )
  )
) as first_result \gset
reset role;

select is((:'first_result')::jsonb ->> 'status', 'in_progress', 'visit starts in progress');
select is((:'first_result')::jsonb ->> 'clientId', '10000000-0000-4000-8000-000000000091', 'client is derived from the route stop');
select is((:'first_result')::jsonb ->> 'sellerId', :'seller_a_id', 'seller is derived from current identity and route');
select is((:'first_result')::jsonb ->> 'parameterSetId', '90000000-0000-4000-8000-000000000099', 'current parameter set is derived');
select is((:'first_result')::jsonb #>> '{contextSnapshot,sourceRouteVersionId}', :'route_version_id', 'snapshot preserves source route version');
select is((select count(*)::integer from api.location_events) - :initial_locations, 1, 'optional start location is stored once');
select is((select status from api.route_stop_executions where route_version_stop_id = :'first_stop_id'::uuid), 'in_visit', 'execution moves to in_visit');
select is((select count(*)::integer from private.audit_events where action = 'visit.started.v1') - :initial_audits, 1, 'visit audit is appended once');

set local role authenticated;
select set_config('request.jwt.claim.sub', :'seller_a_id', true);
select api.start_visit(
  '22000000-0000-4000-8000-000000000001',
  '77000000-0000-4000-8000-000000000001',
  jsonb_build_object(
    'schemaVersion', 1, 'offlineId', '55000000-0000-4000-8000-000000000001',
    'routeVersionStopId', :'first_stop_id', 'deviceStartedAt', '2099-09-17T12:00:00.000Z',
    'location', jsonb_build_object('latitude', '-7.115', 'longitude', '-34.864', 'accuracyM', '12.5', 'distanceM', '8')
  )
) as replay_result \gset
select is((:'replay_result')::jsonb, (:'first_result')::jsonb, 'exact replay returns the canonical result');
reset role;
select is((select count(*)::integer from api.visits) - :initial_visits, 1, 'replay does not duplicate the visit');
select is((select count(*)::integer from api.location_events) - :initial_locations, 1, 'replay does not duplicate location');
select is((select count(*)::integer from private.audit_events where action = 'visit.started.v1') - :initial_audits, 1, 'replay does not duplicate audit');

set local role authenticated;
select set_config('request.jwt.claim.sub', :'seller_a_id', true);
select throws_ok(
  format($sql$select api.start_visit(
    '22000000-0000-4000-8000-000000000001'::uuid,
    '77000000-0000-4000-8000-000000000001'::uuid,
    jsonb_build_object('schemaVersion', 1, 'offlineId', '55000000-0000-4000-8000-000000000001',
      'routeVersionStopId', %L, 'deviceStartedAt', '2099-09-17T12:00:01.000Z'))$sql$, :'first_stop_id'),
  'P0001', 'IDEMPOTENCY_KEY_REUSED', 'divergent payload with the same key is rejected'
);
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', :'seller_a_id', true);
select throws_ok(
  format($sql$select api.start_visit(
    '22000000-0000-4000-8000-000000000010'::uuid,
    '77000000-0000-4000-8000-000000000010'::uuid,
    jsonb_build_object('schemaVersion', 1, 'offlineId', '55000000-0000-4000-8000-000000000010',
      'routeVersionStopId', %L, 'deviceStartedAt', '2099-09-17T12:10:00.000Z', 'sellerId', %L))$sql$,
    :'first_stop_id', :'seller_a_id'),
  'P0001', 'VALIDATION_FAILED', 'direct visit command rejects unknown authority keys'
);
select throws_ok(
  format($sql$select api.start_visit(
    '22000000-0000-4000-8000-000000000011'::uuid,
    '77000000-0000-4000-8000-000000000011'::uuid,
    jsonb_build_object('schemaVersion', 1, 'offlineId', '55000000-0000-4000-8000-000000000011',
      'routeVersionStopId', %L, 'deviceStartedAt', '2099-09-17T12:11:00.000Z',
      'location', jsonb_build_object('latitude', '-7.115', 'longitude', '-34.864', 'tracking', true)))$sql$,
    :'first_stop_id'),
  'P0001', 'VALIDATION_FAILED', 'visit location rejects unknown tracking keys'
);
select throws_ok(
  format($sql$select api.sync_event(
    '22000000-0000-4000-8000-000000000012'::uuid,
    jsonb_build_object(
      'eventId', '66000000-0000-4000-8000-000000000012',
      'idempotencyKey', '77000000-0000-4000-8000-000000000012',
      'operation', 'visit.started.v1', 'schemaVersion', 1, 'sequence', 1,
      'aggregateType', 'visit', 'aggregateId', '55000000-0000-4000-8000-000000000012',
      'occurredAt', '2099-09-17T12:12:00.000Z',
      'payload', jsonb_build_object(
        'offlineId', '55000000-0000-4000-8000-000000000012',
        'routeVersionStopId', %L, 'deviceStartedAt', '2099-09-17T12:12:00.000Z',
        'contextSnapshot', jsonb_build_object('forged', true))))$sql$, :'first_stop_id'),
  'P0001', 'VALIDATION_FAILED', 'sync visit payload rejects unknown snapshot keys'
);
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', :'seller_b_id', true);
select throws_ok(
  format($sql$select api.start_visit(
    '22000000-0000-4000-8000-000000000002'::uuid,
    '77000000-0000-4000-8000-000000000002'::uuid,
    jsonb_build_object('schemaVersion', 1, 'offlineId', '55000000-0000-4000-8000-000000000002',
      'routeVersionStopId', %L, 'deviceStartedAt', '2099-09-17T12:01:00.000Z'))$sql$, :'second_stop_id'),
  'P0001', 'FORBIDDEN', 'another seller cannot enumerate or start the stop'
);
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_a_id', true);
select throws_ok(
  format($sql$select api.start_visit(
    '22000000-0000-4000-8000-000000000003'::uuid,
    '77000000-0000-4000-8000-000000000003'::uuid,
    jsonb_build_object('schemaVersion', 1, 'offlineId', '55000000-0000-4000-8000-000000000003',
      'routeVersionStopId', %L, 'deviceStartedAt', '2099-09-17T12:02:00.000Z'))$sql$, :'second_stop_id'),
  'P0001', 'FORBIDDEN', 'manager cannot start a seller visit'
);
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', :'administrator_id', true);
select throws_ok(
  format($sql$select api.start_visit(
    '22000000-0000-4000-8000-000000000003'::uuid,
    '77000000-0000-4000-8000-000000000003'::uuid,
    jsonb_build_object('schemaVersion', 1, 'offlineId', '55000000-0000-4000-8000-000000000003',
      'routeVersionStopId', %L, 'deviceStartedAt', '2099-09-17T12:02:00.000Z'))$sql$, :'second_stop_id'),
  'P0001', 'FORBIDDEN', 'administrator has no implicit authority to start visits'
);
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', :'seller_a_id', true);
select throws_ok(
  format($sql$select api.start_visit(
    '22000000-0000-4000-8000-000000000004'::uuid,
    '77000000-0000-4000-8000-000000000004'::uuid,
    jsonb_build_object('schemaVersion', 1, 'offlineId', '55000000-0000-4000-8000-000000000004',
      'routeVersionStopId', %L, 'deviceStartedAt', '2099-09-17T12:02:00.000Z'))$sql$, stop_id),
  'P0001', error_code, description
) from (values
  (:'first_stop_id', 'VERSION_CONFLICT', 'a new intention cannot start an already active stop'),
  ('ffffffff-ffff-4fff-8fff-ffffffffffff', 'FORBIDDEN', 'missing stop returns the same non-enumerating denial')
) cases(stop_id, error_code, description);
reset role;

-- Capture the offline intention before republication; do not send it to the server yet.
select jsonb_build_object(
    'eventId', '66000000-0000-4000-8000-000000000002',
    'idempotencyKey', '77000000-0000-4000-8000-000000000002',
    'operation', 'visit.started.v1', 'schemaVersion', 1, 'sequence', 1,
    'aggregateType', 'visit', 'aggregateId', '55000000-0000-4000-8000-000000000002',
    'occurredAt', '2099-09-17T12:03:00.000Z',
    'payload', jsonb_build_object(
      'offlineId', '55000000-0000-4000-8000-000000000002',
      'routeVersionStopId', :'second_stop_id',
      'deviceStartedAt', '2099-09-17T12:03:00.000Z'
    )
) as deferred_command \gset
select (:'deferred_command')::jsonb || jsonb_build_object(
  'eventId', '66000000-0000-4000-8000-000000000093',
  'idempotencyKey', '77000000-0000-4000-8000-000000000093',
  'aggregateId', '55000000-0000-4000-8000-000000000093',
  'payload', jsonb_build_object('offlineId', '55000000-0000-4000-8000-000000000093',
    'routeVersionStopId', :'removed_stop_id', 'deviceStartedAt', '2099-09-17T12:03:00.000Z')
) as removed_command \gset
select is((select count(*)::integer from api.visits) - :initial_visits, 1, 'offline intention has not reached the server before republication');
select is((select status from api.route_stop_executions where route_version_stop_id = :'second_stop_id'::uuid), 'pending', 'server still considers the offline stop pending');

-- The first visit is known to the server; the second exists only as the captured offline intention.
update api.clients set name = 'Cadastro atualizado durante visita offline'
where id = '10000000-0000-4000-8000-000000000092';
select lock_version as route_lock_version from api.routes where id = :'route_id'::uuid \gset
set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_a_id', true);
select api.change_route_composition(:'route_id'::uuid, jsonb_build_object(
  'schemaVersion', 1, 'expectedVersion', :route_lock_version, 'reason', 'Revisao sintetica apos inicio',
  'stops', jsonb_build_array(
    jsonb_build_object('clientId', '10000000-0000-4000-8000-000000000092', 'plannedOrder', 1, 'priority', 1),
    jsonb_build_object('clientId', '10000000-0000-4000-8000-000000000091', 'plannedOrder', 2, 'priority', 0)
  )), '77000000-0000-4000-8000-000000000099'::uuid, 'cli') as revised_route \gset
select api.publish_route(:'route_id'::uuid, ((:'revised_route')::jsonb ->> 'expectedVersion')::integer) as republished_route \gset
reset role;
select is((:'republished_route')::jsonb ->> 'status', 'published', 'successor route is published after visit start');
select isnt((:'republished_route')::jsonb ->> 'routeVersionId', :'route_version_id', 'successor has a new route version');
select is((select route_version_stop_id::text from api.visits where id = ((:'first_result')::jsonb ->> 'visitId')::uuid), :'first_stop_id', 'visit retains its original versioned stop');
select is((select context_snapshot from api.visits where id = ((:'first_result')::jsonb ->> 'visitId')::uuid), (:'first_result')::jsonb -> 'contextSnapshot', 'republishing does not rewrite any historical context');
set local role authenticated;
select set_config('request.jwt.claim.sub', :'seller_a_id', true);
select is(api.start_visit(
  '22000000-0000-4000-8000-000000000001', '77000000-0000-4000-8000-000000000001',
  jsonb_build_object('schemaVersion', 1, 'offlineId', '55000000-0000-4000-8000-000000000001',
    'routeVersionStopId', :'first_stop_id', 'deviceStartedAt', '2099-09-17T12:00:00.000Z',
    'location', jsonb_build_object('latitude', '-7.115', 'longitude', '-34.864', 'accuracyM', '12.5', 'distanceM', '8'))
), (:'first_result')::jsonb, 'replay after republishing returns the same canonical visit');
reset role;

select is((select status from api.route_versions where id = :'route_version_id'::uuid), 'superseded', 'offline intention arrives only after its source version was superseded');
set local role authenticated;
select set_config('request.jwt.claim.sub', :'seller_a_id', true);
select api.sync_event('22000000-0000-4000-8000-000000000001', :'deferred_command'::jsonb) as sync_result \gset
select is(api.sync_event('22000000-0000-4000-8000-000000000001', :'deferred_command'::jsonb),
  :'sync_result'::jsonb, 'delayed offline envelope replays with the same canonical confirmation');
reset role;
select is((:'sync_result')::jsonb ->> 'status', 'confirmed', 'sync envelope confirms visit start');
select is((select count(*)::integer from api.visits) - :initial_visits, 2, 'sync path creates exactly one second visit');
select is((select count(*)::integer from api.location_events) - :initial_locations, 1, 'absence of location creates no location event');
select is((select status from api.route_stop_executions where route_version_stop_id = :'second_stop_id'::uuid), 'in_visit', 'sync path moves its original execution to in_visit');
select is((select count(*)::integer from private.audit_events where action = 'visit.started.v1') - :initial_audits, 2, 'each visit has one audit event');
select is((select route_version_id::text from api.visits where id = ((:'sync_result')::jsonb ->> 'canonicalId')::uuid),
  :'route_version_id', 'delayed offline visit retains the original route version');
select is((select context_snapshot #>> '{client,name}' from api.visits where id = ((:'sync_result')::jsonb ->> 'canonicalId')::uuid),
  'Cliente Visita 02', 'delayed offline visit uses the original client snapshot, not the later cadastro');
select is((select execution.status from api.route_stop_executions execution
  join api.route_version_stops stop on stop.id = execution.route_version_stop_id
  where stop.route_version_id = ((:'republished_route')::jsonb ->> 'routeVersionId')::uuid
    and stop.client_id = '10000000-0000-4000-8000-000000000092'),
  'pending', 'delayed start does not silently reassociate its effect with the successor stop');

-- Business decision 2026-09-17: removal does not discard work from the old offline route.
set local role authenticated;
select set_config('request.jwt.claim.sub', :'seller_a_id', true);
select api.sync_event('22000000-0000-4000-8000-000000000001', :'removed_command'::jsonb) as removed_result \gset
select is(api.sync_event('22000000-0000-4000-8000-000000000001', :'removed_command'::jsonb),
  :'removed_result'::jsonb, 'removed-client offline start replays the same canonical confirmation');
reset role;
select is((:'removed_result')::jsonb ->> 'status', 'confirmed', 'removed-client offline start synchronizes after republication');
select is((select route_version_stop_id::text from api.visits where id = ((:'removed_result')::jsonb ->> 'canonicalId')::uuid),
  :'removed_stop_id', 'removed-client visit retains its original stop');
select is((select route_version_id::text from api.visits where id = ((:'removed_result')::jsonb ->> 'canonicalId')::uuid),
  :'route_version_id', 'removed-client visit retains its original version');
select is((select context_snapshot #>> '{client,name}' from api.visits where id = ((:'removed_result')::jsonb ->> 'canonicalId')::uuid),
  'Cliente Retirado Offline', 'removed-client original snapshot remains available');
select is((select status from api.route_stop_executions where route_version_stop_id = :'removed_stop_id'::uuid),
  'in_visit', 'removed-client start updates only the historical execution');
select is((select count(*)::integer from api.visits) - :initial_visits, 3, 'removed-client replay creates no duplicate');
select is((select count(*)::integer from api.route_version_stops
  where route_version_id = ((:'republished_route')::jsonb ->> 'routeVersionId')::uuid
    and client_id = '10000000-0000-4000-8000-000000000093'), 0, 'synchronization does not reinsert the removed client into the current route');

update api.clients set name = 'Cadastro posterior alterado'
where id = '10000000-0000-4000-8000-000000000091';
select is((
  select context_snapshot #>> '{client,name}' from api.visits
  where offline_id = '55000000-0000-4000-8000-000000000001'
), 'Cliente Visita 01', 'later client changes do not rewrite visit context');

update api.user_profiles set status = 'inactive', blocked_at = clock_timestamp()
where id = :'seller_a_id'::uuid;
set local role authenticated;
select set_config('request.jwt.claim.sub', :'seller_a_id', true);
select throws_ok(
  format($sql$select api.start_visit(
    '22000000-0000-4000-8000-000000000001'::uuid,
    '77000000-0000-4000-8000-000000000001'::uuid,
    jsonb_build_object('schemaVersion', 1, 'offlineId', '55000000-0000-4000-8000-000000000001',
      'routeVersionStopId', %L, 'deviceStartedAt', '2099-09-17T12:00:00.000Z',
      'location', jsonb_build_object('latitude', '-7.115', 'longitude', '-34.864', 'accuracyM', '12.5', 'distanceM', '8')))$sql$, :'first_stop_id'),
  'P0001', 'FORBIDDEN', 'current authorization is revalidated before an idempotent replay'
);
reset role;
select is((select count(*)::integer from api.visits) - :initial_visits, 3, 'failed authorization leaves all visit effects unchanged');

select * from finish();
rollback;
