begin;

select plan(29);

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
select ok(not has_table_privilege('authenticated', 'api.visits', 'SELECT'),
  'authenticated cannot select the underlying visit facts directly');
select has_index(
  'api', 'visits', 'visits_pilot_metrics_idx',
  'pilot metrics has a partial index compatible with its range and total order'
);
select is(regexp_count(
  pg_get_functiondef('private.get_pilot_metrics(date,date,uuid,uuid,text,text)'::regprocedure),
  'order by page\.service_date desc, page\.server_completed_at desc, page\.visit_id desc'
)::integer, 2, 'both limited page projections preserve the canonical total order');

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
   clock_timestamp() - interval '1 hour', clock_timestamp(), repeat('2',64)),
  ('41000000-0000-4000-8000-000000000001', gen_random_uuid(), gen_random_uuid(),
   :'pilot_stop_id', :'pilot_route_version_id', :'pilot_client_id', :'seller_a_id',
   :'pilot_parameter_set_id', 'completed',
   jsonb_build_object('route', jsonb_build_object('serviceDate', '2000-01-01'),
     'seller', jsonb_build_object('displayName', 'Vendedor sintético'),
     'client', jsonb_build_object('name', 'Cliente sintético')),
   repeat('3',64), '2000-01-01 08:00+00', '2000-01-01 08:01+00',
   '2000-01-01 10:00+00', '2000-01-02 10:00+00', repeat('4',64)),
  ('41000000-0000-4000-8000-000000000002', gen_random_uuid(), gen_random_uuid(),
   :'pilot_stop_id', :'pilot_route_version_id', :'pilot_client_id', :'seller_a_id',
   :'pilot_parameter_set_id', 'completed',
   jsonb_build_object('route', jsonb_build_object('serviceDate', '2000-01-01'),
     'seller', jsonb_build_object('displayName', 'Vendedor sintético'),
     'client', jsonb_build_object('name', 'Cliente sintético')),
   repeat('5',64), '2000-01-01 08:00+00', '2000-01-01 08:01+00',
   '2000-01-01 10:00+00', '2000-01-01 10:00+00', repeat('6',64));

reset role;
insert into api.stock_snapshots (
  visit_id, heliar_quantity, moura_quantity, last_event_id, device_saved_at, server_saved_at
) values ('41000000-0000-4000-8000-000000000001', 1, 1, gen_random_uuid(),
  '2000-01-01 09:00+00', '2000-01-01 09:01+00');
insert into api.competitor_price_reports (
  visit_id, parameter_set_id, availability, last_event_id, device_saved_at, server_saved_at
) values ('41000000-0000-4000-8000-000000000001', :'pilot_parameter_set_id', 'available',
  gen_random_uuid(), '2000-01-01 09:00+00', '2000-01-01 09:01+00');
insert into api.visit_commercial_action_reports (
  visit_id, competitor_availability, last_event_id, device_saved_at, server_saved_at
) values ('41000000-0000-4000-8000-000000000001', 'not_identified', gen_random_uuid(),
  '2000-01-01 09:00+00', '2000-01-01 09:01+00');
insert into api.scrap_reports (visit_id, availability, last_event_id, device_saved_at)
values ('41000000-0000-4000-8000-000000000001', 'none', gen_random_uuid(), '2000-01-01 09:00+00');

insert into api.visits (
  id, offline_id, device_id, route_version_stop_id, route_version_id, client_id, seller_id,
  parameter_set_id, status, context_snapshot, start_payload_hash, device_started_at,
  server_started_at, device_completed_at, server_completed_at, completion_payload_hash
)
select gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), :'pilot_stop_id', :'pilot_route_version_id',
  :'pilot_client_id', :'seller_a_id', :'pilot_parameter_set_id', 'completed',
  jsonb_build_object('route', jsonb_build_object('serviceDate', '2000-01-03'),
    'seller', jsonb_build_object('displayName', 'Vendedor sintético'),
    'client', jsonb_build_object('name', 'Cliente sintético')),
  repeat('7',64), '2000-01-03 08:00+00', '2000-01-03 08:01+00',
  '2000-01-03 09:00+00'::timestamptz + make_interval(secs => item),
  '2000-01-03 10:00+00'::timestamptz + make_interval(secs => item), repeat('8',64)
from generate_series(1, 51) item;
reset role;
do $visit_ownership$
begin
  execute pg_catalog.format('revoke cirne_visit_executor from %I granted by current_user', current_user);
end
$visit_ownership$;

set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_a_id', true);
select api.get_pilot_metrics('2000-01-01','2000-01-01',null,null,null,'America/Sao_Paulo') as result \gset
select is((:'result')::jsonb #>> '{totals,completed}', '6', 'completed cohort contains only scoped server confirmations');
select is((:'result')::jsonb #>> '{totals,requiredComplete}', '1', 'present required reports count while missing sections do not');
select is((:'result')::jsonb #>> '{totals,scrapReported}', '1', 'an explicit scrap response counts while absence does not');
select is((:'result')::jsonb #>> '{totals,commercialActionReported}', '1', 'an explicit negative action response counts while absence does not');
select is((:'result')::jsonb #>> '{totals,syncWithin24h}', '3', 'within, exact 24-hour and equal timestamps count');
select is((:'result')::jsonb #>> '{totals,syncEligible}', '4', 'open windows and suspicious clocks stay outside the denominator');
select is((:'result')::jsonb #>> '{totals,windowOpen}', '1', 'open 24-hour window remains visible');
select is((:'result')::jsonb #>> '{totals,clockSuspicious}', '1', 'device time after server time is explicitly suspicious');
select is(jsonb_array_length((:'result')::jsonb -> 'records'), 5, 'fully complete visits leave the exception drilldown');
select ok((:'result')::text !~* '(latitude|longitude|storagePath|signedUrl|payload|idempotency)',
  'projection excludes location, evidence and synchronization payloads');
select ok(jsonb_path_exists((:'result')::jsonb, '$.records[*] ? (@.visitId == "41000000-0000-4000-8000-000000000002" && @.checks.sync24h == "within_24h")'),
  'equal device and server timestamps are classified within 24 hours');
select ok(not jsonb_path_exists((:'result')::jsonb, '$.records[*] ? (@.visitId == "41000000-0000-4000-8000-000000000001")'),
  'the exact 24-hour boundary is inclusive and a complete visit is not an exception');

select api.get_pilot_metrics('2000-01-03','2000-01-03',null,null,null,'America/Sao_Paulo') as page_one \gset
select api.get_pilot_metrics(
  '2000-01-03','2000-01-03',null,null,(:'page_one')::jsonb ->> 'nextCursor','America/Sao_Paulo'
) as page_two \gset
select is(jsonb_array_length((:'page_one')::jsonb -> 'records'), 50, 'first exception page is capped at 50 records');
select isnt((:'page_one')::jsonb ->> 'nextCursor', null, 'first exception page returns an opaque cursor');
select is(jsonb_array_length((:'page_two')::jsonb -> 'records'), 1, 'second exception page returns the remaining record');
select is((:'page_two')::jsonb ->> 'nextCursor', null, 'last exception page has no cursor');
select is((
  select count(*) from jsonb_array_elements((:'page_one')::jsonb -> 'records') first_page
  join jsonb_array_elements((:'page_two')::jsonb -> 'records') second_page
    on first_page ->> 'visitId' = second_page ->> 'visitId'
)::integer, 0, 'cursor pages do not overlap');
select is((
  select count(distinct record ->> 'visitId')
  from jsonb_array_elements((:'page_one')::jsonb -> 'records') record
  union all
  select count(distinct record ->> 'visitId')
  from jsonb_array_elements((:'page_two')::jsonb -> 'records') record
  limit 1
)::integer, 50, 'first cursor page contains unique visits');
select is((
  select count(distinct record ->> 'visitId')
  from (
    select record from jsonb_array_elements((:'page_one')::jsonb -> 'records') record
    union all
    select record from jsonb_array_elements((:'page_two')::jsonb -> 'records') record
  ) pages
)::integer, 51, 'cursor traversal has no loss or duplication');

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
