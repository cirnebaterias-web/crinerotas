begin;

select plan(18);

select has_function(
  'api', 'get_pilot_metrics', array['date','date','uuid','uuid','text','text'],
  'guarded pilot metrics projection exists'
);
select ok(has_function_privilege(
  'authenticated', 'api.get_pilot_metrics(date,date,uuid,uuid,text,text)', 'EXECUTE'
), 'authenticated can execute the guarded projection');
select ok(not has_function_privilege(
  'anon', 'api.get_pilot_metrics(date,date,uuid,uuid,text,text)', 'EXECUTE'
), 'anon cannot execute the projection');
select ok(not has_table_privilege('authenticated', 'api.field_intelligence_v', 'SELECT'),
  'authenticated cannot select the underlying projection directly');

select id as seller_a_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'seller_a'
  order by created_at desc limit 1 \gset
select id as seller_b_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'seller_b'
  order by created_at desc limit 1 \gset
select id as manager_a_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'manager_a'
  order by created_at desc limit 1 \gset
select id as seller_actor_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'seller_a'
  order by created_at desc limit 1 \gset
select id as blocked_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'blocked'
  order by created_at desc limit 1 \gset

set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_a_id', true);
select api.create_route_draft(jsonb_build_object(
  'schemaVersion', 1, 'serviceDate', '2299-12-01', 'sellerId', :'seller_a_id',
  'stops', jsonb_build_array(jsonb_build_object(
    'clientId', '10000000-0000-4000-8000-000000000001', 'plannedOrder', 1, 'priority', 0
  ))
)) as pilot_route \gset
select api.publish_route(((:'pilot_route')::jsonb ->> 'routeId')::uuid, 1);
reset role;

select id as pilot_stop_id, route_version_id as pilot_route_version_id, client_id as pilot_client_id
from api.route_version_stops
where route_version_id = ((:'pilot_route')::jsonb ->> 'routeVersionId')::uuid limit 1 \gset
select id as pilot_parameter_set_id from api.parameter_sets
where status = 'published' order by published_at desc nulls last limit 1 \gset

do $visit_ownership$
begin
  execute pg_catalog.format('grant cirne_visit_executor to %I with set true granted by current_user', current_user);
end
$visit_ownership$;
set local role cirne_visit_executor;
insert into api.visits (
  id, offline_id, device_id, route_version_stop_id, route_version_id, client_id, seller_id,
  parameter_set_id, status, context_snapshot, start_payload_hash, device_started_at,
  server_started_at, device_completed_at, server_completed_at, completion_payload_hash
) values
  (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), :'pilot_stop_id', :'pilot_route_version_id',
   :'pilot_client_id', :'seller_a_id', :'pilot_parameter_set_id', 'completed',
   jsonb_build_object('route', jsonb_build_object('serviceDate', '2000-01-01'),
     'seller', jsonb_build_object('displayName', 'Vendedor sintético'),
     'client', jsonb_build_object('name', 'Cliente sintético')),
   repeat('a',64), '2000-01-01 09:00+00', '2000-01-01 09:01+00',
   '2000-01-01 10:00+00', '2000-01-01 11:00+00', repeat('b',64)),
  (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), :'pilot_stop_id', :'pilot_route_version_id',
   :'pilot_client_id', :'seller_a_id', :'pilot_parameter_set_id', 'completed',
   jsonb_build_object('route', jsonb_build_object('serviceDate', '2000-01-01'),
     'seller', jsonb_build_object('displayName', 'Vendedor sintético'),
     'client', jsonb_build_object('name', 'Cliente sintético')),
   repeat('c',64), '2000-01-01 09:00+00', '2000-01-01 09:01+00',
   '2000-01-01 10:00+00', '2000-01-02 11:00+00', repeat('d',64)),
  (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), :'pilot_stop_id', :'pilot_route_version_id',
   :'pilot_client_id', :'seller_a_id', :'pilot_parameter_set_id', 'completed',
   jsonb_build_object('route', jsonb_build_object('serviceDate', '2000-01-01'),
     'seller', jsonb_build_object('displayName', 'Vendedor sintético'),
     'client', jsonb_build_object('name', 'Cliente sintético')),
   repeat('e',64), '2000-01-01 09:00+00', '2000-01-01 09:01+00',
   '2000-01-02 10:00+00', '2000-01-02 09:00+00', repeat('f',64)),
  (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), :'pilot_stop_id', :'pilot_route_version_id',
   :'pilot_client_id', :'seller_a_id', :'pilot_parameter_set_id', 'completed',
   jsonb_build_object('route', jsonb_build_object('serviceDate', '2000-01-01'),
     'seller', jsonb_build_object('displayName', 'Vendedor sintético'),
     'client', jsonb_build_object('name', 'Cliente sintético')),
   repeat('1',64), clock_timestamp() - interval '2 hours', clock_timestamp() - interval '2 hours',
   clock_timestamp() - interval '1 hour', clock_timestamp(), repeat('2',64));
reset role;
do $visit_ownership$
begin
  execute pg_catalog.format('revoke cirne_visit_executor from %I granted by current_user', current_user);
end
$visit_ownership$;

set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_a_id', true);
select api.get_pilot_metrics('2000-01-01','2000-01-01',null,null,null,'America/Sao_Paulo') as result \gset
select is((:'result')::jsonb #>> '{totals,completed}', '4', 'completed cohort contains only scoped server confirmations');
select is((:'result')::jsonb #>> '{totals,requiredComplete}', '0', 'missing required reports do not count as complete');
select is((:'result')::jsonb #>> '{totals,scrapReported}', '0', 'missing scrap report is not inferred');
select is((:'result')::jsonb #>> '{totals,commercialActionReported}', '0', 'missing action report is not inferred');
select is((:'result')::jsonb #>> '{totals,syncWithin24h}', '1', 'only eligible confirmations within 24 hours count');
select is((:'result')::jsonb #>> '{totals,syncEligible}', '2', 'open windows and suspicious clocks stay outside the denominator');
select is((:'result')::jsonb #>> '{totals,windowOpen}', '1', 'open 24-hour window remains visible');
select is((:'result')::jsonb #>> '{totals,clockSuspicious}', '1', 'device time after server time is explicitly suspicious');
select is(jsonb_array_length((:'result')::jsonb -> 'records'), 4, 'exception drilldown includes the four synthetic visits');
select ok((:'result')::text !~* '(latitude|longitude|storagePath|signedUrl|payload|idempotency)',
  'projection excludes location, evidence and synchronization payloads');

select set_config('request.jwt.claim.sub', :'seller_actor_id', true);
select throws_ok($$select api.get_pilot_metrics(
  '2000-01-01','2000-01-01',null,null,null,'America/Sao_Paulo'
)$$, 'P0001', 'FORBIDDEN', 'seller cannot read pilot metrics');
select set_config('request.jwt.claim.sub', :'blocked_id', true);
select throws_ok($$select api.get_pilot_metrics(
  '2000-01-01','2000-01-01',null,null,null,'America/Sao_Paulo'
)$$, 'P0001', 'FORBIDDEN', 'blocked actor cannot read pilot metrics');
select set_config('request.jwt.claim.sub', :'manager_a_id', true);
select throws_ok(format($sql$select api.get_pilot_metrics(
  '2000-01-01','2000-01-01',%L,null,null,'America/Sao_Paulo'
)$sql$, :'seller_b_id'), 'P0001', 'FORBIDDEN', 'manager cannot widen the seller scope');
select throws_ok($$select api.get_pilot_metrics(
  '2000-01-02','2000-01-01',null,null,null,'America/Sao_Paulo'
)$$, 'P0001', 'VALIDATION_FAILED', 'inverted interval is rejected');
reset role;

select * from finish();
rollback;
