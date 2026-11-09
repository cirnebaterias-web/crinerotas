begin;

select plan(12);

select has_function(
  'api',
  'save_visit_checkin_evidence',
  array['uuid', 'uuid', 'jsonb'],
  'check-in evidence wrapper exists'
);
select ok(
  has_function_privilege('authenticated', 'api.save_visit_checkin_evidence(uuid,uuid,jsonb)', 'EXECUTE'),
  'authenticated seller can save check-in evidence'
);

select id as seller_id
from auth.users
where raw_user_meta_data ->> 'actorKey' = 'seller_a'
\gset

select id as manager_id
from auth.users
where raw_user_meta_data ->> 'actorKey' = 'manager_a'
\gset

select id as administrator_id
from auth.users
where raw_user_meta_data ->> 'actorKey' = 'administrator'
\gset

update api.parameter_sets set status = 'retired' where status = 'published';
insert into api.parameter_sets (
  id, version, status, valid_from, published_at, published_by
) values (
  '43100000-0000-4000-8000-000000000099', 431, 'published',
  '2099-01-01T00:00:00Z', '2099-01-01T00:00:00Z', :'administrator_id'
);

insert into api.clients (
  id,
  external_reference,
  name,
  address,
  portfolio_reference,
  location
) values (
  '43100000-0000-4000-8000-000000000001',
  'CHECKIN-EXCEPTION-001',
  'Cliente Excecao Check-in',
  'Rua de Teste, Natal/RN',
  'CARTEIRA-CHECKIN',
  extensions.st_setsrid(extensions.st_makepoint(-35.211, -5.7945), 4326)::extensions.geography
);

insert into api.client_seller_scopes (client_id, seller_id, assigned_by)
values (
  '43100000-0000-4000-8000-000000000001',
  :'seller_id',
  :'manager_id'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_id', true);
select api.create_route_draft(jsonb_build_object(
  'schemaVersion', 1,
  'serviceDate', '2099-11-20',
  'sellerId', :'seller_id',
  'stops', jsonb_build_array(jsonb_build_object(
    'clientId', '43100000-0000-4000-8000-000000000001',
    'plannedOrder', 1,
    'priority', 1
  ))
)) as draft_result
\gset
reset role;
select pass('manager creates the route prerequisite');

select (:'draft_result')::jsonb ->> 'routeId' as route_id
\gset
select (:'draft_result')::jsonb ->> 'routeVersionId' as route_version_id
\gset
select id as stop_id
from api.route_version_stops
where route_version_id = :'route_version_id'::uuid
\gset

set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_id', true);
select api.publish_route(:'route_id'::uuid, 1) as publication_result
\gset
reset role;
select is((:'publication_result')::jsonb ->> 'status', 'published', 'route prerequisite is published');

set local role authenticated;
select set_config('request.jwt.claim.sub', :'seller_id', true);
select api.start_visit(
  '43100000-0000-4000-8000-000000000002',
  '43100000-0000-4000-8000-000000000003',
  jsonb_build_object(
    'schemaVersion', 1,
    'offlineId', '43100000-0000-4000-8000-000000000004',
    'routeVersionStopId', :'stop_id',
    'deviceStartedAt', '2099-11-20T12:00:00.000Z'
  )
) as visit_result
\gset
reset role;
select is((:'visit_result')::jsonb ->> 'status', 'in_progress', 'visit starts before evidence synchronization');

set local role authenticated;
select set_config('request.jwt.claim.sub', :'seller_id', true);
select throws_ok(
  $$select api.save_visit_checkin_evidence(
    '43100000-0000-4000-8000-000000000002',
    '43100000-0000-4000-8000-000000000005',
    jsonb_build_object(
      'schemaVersion', 1,
      'offlineId', '43100000-0000-4000-8000-000000000004',
      'evidence', jsonb_build_object(
        'offlineId', '43100000-0000-4000-8000-000000000006',
        'capturedAt', '2099-11-20T12:01:00.000Z',
        'location', jsonb_build_object(
          'latitude', '-5.8', 'longitude', '-35.22', 'accuracyM', '12', 'distanceM', '1200'
        ),
        'issues', jsonb_build_array('camera_unavailable'),
        'justification', 'Teste distante sem o marcador obrigatorio.'
      )
    )
  )$$,
  'P0001',
  'VALIDATION_FAILED',
  'distant check-in without outside-radius marker is rejected'
);

select throws_ok(
  $$select api.save_visit_checkin_evidence(
    '43100000-0000-4000-8000-000000000002',
    '43100000-0000-4000-8000-000000000007',
    jsonb_build_object(
      'schemaVersion', 1,
      'offlineId', '43100000-0000-4000-8000-000000000004',
      'evidence', jsonb_build_object(
        'offlineId', '43100000-0000-4000-8000-000000000008',
        'capturedAt', '2099-11-20T12:01:30.000Z',
        'location', jsonb_build_object(
          'latitude', '-5.8', 'longitude', '-35.22', 'accuracyM', '12', 'distanceM', '1200'
        ),
        'issues', jsonb_build_array('camera_unavailable', 'outside_radius')
      )
    )
  )$$,
  'P0001',
  'VALIDATION_FAILED',
  'distant check-in without justification is rejected'
);

select api.save_visit_checkin_evidence(
  '43100000-0000-4000-8000-000000000002',
  '43100000-0000-4000-8000-000000000009',
  jsonb_build_object(
    'schemaVersion', 1,
    'offlineId', '43100000-0000-4000-8000-000000000004',
    'evidence', jsonb_build_object(
      'offlineId', '43100000-0000-4000-8000-000000000010',
      'capturedAt', '2099-11-20T12:02:00.000Z',
      'location', jsonb_build_object(
        'latitude', '-5.8', 'longitude', '-35.22', 'accuracyM', '12', 'distanceM', '1200'
      ),
      'issues', jsonb_build_array('camera_unavailable', 'outside_radius'),
      'justification', 'Teste funcional autorizado fora do estabelecimento.'
    )
  )
) as evidence_result
\gset
reset role;

select is((:'evidence_result')::jsonb ->> 'kind', 'checkin', 'justified distant check-in is accepted');
select ok(
  (select issues @> array['outside_radius'] from api.location_events
   where visit_id = ((:'visit_result')::jsonb ->> 'visitId')::uuid and kind = 'start'),
  'outside-radius marker remains stored for audit'
);
select is(
  (select exception_reason from api.location_events
   where visit_id = ((:'visit_result')::jsonb ->> 'visitId')::uuid and kind = 'start'),
  'Teste funcional autorizado fora do estabelecimento.',
  'justification remains stored for audit'
);
select ok(
  (select not extensions.st_dwithin(
    position,
    extensions.st_setsrid(extensions.st_makepoint(-35.211, -5.7945), 4326)::extensions.geography,
    30
  ) from api.location_events
   where visit_id = ((:'visit_result')::jsonb ->> 'visitId')::uuid and kind = 'start'),
  'captured position remains the actual distant point'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', :'seller_id', true);
select is(
  api.save_visit_checkin_evidence(
    '43100000-0000-4000-8000-000000000002',
    '43100000-0000-4000-8000-000000000009',
    jsonb_build_object(
      'schemaVersion', 1,
      'offlineId', '43100000-0000-4000-8000-000000000004',
      'evidence', jsonb_build_object(
        'offlineId', '43100000-0000-4000-8000-000000000010',
        'capturedAt', '2099-11-20T12:02:00.000Z',
        'location', jsonb_build_object(
          'latitude', '-5.8', 'longitude', '-35.22', 'accuracyM', '12', 'distanceM', '1200'
        ),
        'issues', jsonb_build_array('camera_unavailable', 'outside_radius'),
        'justification', 'Teste funcional autorizado fora do estabelecimento.'
      )
    )
  ),
  (:'evidence_result')::jsonb,
  'justified evidence replay remains idempotent'
);
reset role;

select * from finish();
rollback;
