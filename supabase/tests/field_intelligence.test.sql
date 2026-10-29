begin;

select plan(25);

select has_view('api', 'field_intelligence_v', 'narrow field intelligence projection exists');
select has_function(
  'api', 'get_field_intelligence',
  array['text','date','date','uuid','uuid','uuid','text','text','text'],
  'guarded field intelligence reader exists'
);
select ok(not has_table_privilege('authenticated', 'api.field_intelligence_v', 'SELECT'),
  'authenticated cannot select the projection directly');
select ok(has_function_privilege(
  'authenticated',
  'api.get_field_intelligence(text,date,date,uuid,uuid,uuid,text,text,text)',
  'EXECUTE'
), 'authenticated can execute the guarded reader');
select ok(not has_function_privilege(
  'anon',
  'api.get_field_intelligence(text,date,date,uuid,uuid,uuid,text,text,text)',
  'EXECUTE'
), 'anon cannot execute the reader');
select ok(
  not (select rolcanlogin or rolbypassrls or rolsuper
    from pg_catalog.pg_roles where rolname = 'cirne_field_intelligence_executor'),
  'field intelligence executor cannot login or bypass RLS'
);

select id as seller_a_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'seller_a'
  order by created_at desc limit 1 \gset
select id as seller_b_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'seller_b'
  order by created_at desc limit 1 \gset
select id as manager_a_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'manager_a'
  order by created_at desc limit 1 \gset
select id as administrator_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'administrator'
  order by created_at desc limit 1 \gset
select id as blocked_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'blocked'
  order by created_at desc limit 1 \gset

set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_a_id', true);
select api.create_route_draft(jsonb_build_object(
  'schemaVersion', 1,
  'serviceDate', '2299-10-01',
  'sellerId', :'seller_a_id',
  'stops', jsonb_build_array(jsonb_build_object(
    'clientId', '10000000-0000-4000-8000-000000000001',
    'plannedOrder', 1,
    'priority', 0
  ))
)) as pagination_route \gset
select api.publish_route(((:'pagination_route')::jsonb ->> 'routeId')::uuid, 1);
reset role;

select id as pagination_stop_id, route_version_id as pagination_route_version_id,
  client_id as pagination_client_id
from api.route_version_stops
where route_version_id = ((:'pagination_route')::jsonb ->> 'routeVersionId')::uuid
limit 1 \gset
select id as pagination_parameter_set_id from api.parameter_sets
where status = 'published' order by published_at desc nulls last limit 1 \gset

do $visit_ownership$
begin
  execute pg_catalog.format('grant cirne_visit_executor to %I with set true granted by current_user', current_user);
end
$visit_ownership$;
set local role cirne_visit_executor;
insert into api.visits (
  id, offline_id, device_id, route_version_stop_id, route_version_id,
  client_id, seller_id, parameter_set_id, status, context_snapshot,
  start_payload_hash, device_started_at, server_started_at,
  device_completed_at, server_completed_at, completion_payload_hash
)
select
  gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
  :'pagination_stop_id', :'pagination_route_version_id', :'pagination_client_id',
  :'seller_a_id', :'pagination_parameter_set_id', 'completed',
  jsonb_build_object(
    'route', jsonb_build_object('serviceDate', '2299-10-01'),
    'seller', jsonb_build_object('displayName', 'Vendedor paginação'),
    'client', jsonb_build_object('name', 'Cliente paginação')
  ),
  repeat('a', 64),
  timestamptz '2299-10-01 10:00:00+00' + series.number * interval '1 second',
  timestamptz '2299-10-01 10:00:01+00' + series.number * interval '1 second',
  timestamptz '2299-10-01 11:00:00+00' + series.number * interval '1 second',
  timestamptz '2299-10-01 11:00:01+00' + series.number * interval '1 second',
  repeat('b', 64)
from generate_series(1, 55) as series(number);
reset role;
do $visit_ownership$
begin
  execute pg_catalog.format('revoke cirne_visit_executor from %I granted by current_user', current_user);
end
$visit_ownership$;

set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_a_id', true);
select api.get_field_intelligence(
  'results', '2299-10-01', '2299-10-01', null, null, null, null, null, 'America/Sao_Paulo'
) as first_page \gset
select is(jsonb_array_length((:'first_page')::jsonb -> 'records'), 50,
  'first result page is capped at fifty records');
select ok((:'first_page')::jsonb ->> 'nextCursor' !~ '[[:space:]=+/]',
  'pagination cursor is unpadded URL-safe base64 without line breaks');
select api.get_field_intelligence(
  'results', '2299-10-01', '2299-10-01', null, null, null, null,
  (:'first_page')::jsonb ->> 'nextCursor', 'America/Sao_Paulo'
) as second_page \gset
select is(jsonb_array_length((:'second_page')::jsonb -> 'records'), 5,
  'following nextCursor returns the remaining result records');
select is((:'second_page')::jsonb ->> 'nextCursor', null,
  'last result page does not expose another cursor');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_a_id', true);
select api.get_field_intelligence(
  'stock', '2199-01-01', '2199-01-07', null, null, null, null, null, 'America/Sao_Paulo'
) as stock_result \gset
select is((:'stock_result')::jsonb #>> '{indicators,records}', '0', 'stock returns a consistent empty set');
select is(jsonb_array_length((:'stock_result')::jsonb -> 'records'), 0, 'stock empty page contains no records');

select api.get_field_intelligence(
  'prices', '2199-01-01', '2199-01-07', null, null, null, null, null, 'America/Sao_Paulo'
) as price_result \gset
select is((:'price_result')::jsonb #>> '{indicators,quotations}', '0', 'price indicators cover the complete filtered set');

select api.get_field_intelligence(
  'actions', '2199-01-01', '2199-01-07', null, null, null, null, null, 'America/Sao_Paulo'
) as action_result \gset
select is((:'action_result')::jsonb #>> '{indicators,actions}', '0', 'action indicators distinguish no matching actions');

select api.get_field_intelligence(
  'scrap', '2199-01-01', '2199-01-07', null, null, null, null, null, 'America/Sao_Paulo'
) as scrap_result \gset
select is((:'scrap_result')::jsonb #>> '{indicators,collectedWeightKg}', '0', 'collected weight has an independent indicator');
select is((:'scrap_result')::jsonb #>> '{indicators,scheduledWeightKg}', '0', 'scheduled weight has an independent indicator');

select api.get_field_intelligence(
  'results', '2199-01-01', '2199-01-07', null, null, null, null, null, 'America/Sao_Paulo'
) as result_result \gset
select is((:'result_result')::jsonb #>> '{indicators,completedVisits}', '0', 'unconfirmed visits are not classified as results');
select ok((:'first_page')::text !~* '(latitude|longitude|storagePath|signedUrl|payload|idempotency)',
  'response contains no location, evidence or synchronization payload');

select set_config('request.jwt.claim.sub', :'seller_a_id', true);
select throws_ok(format($sql$select api.get_field_intelligence(
  'stock','2199-01-01','2199-01-07',null,null,null,null,null,'America/Sao_Paulo'
)$sql$), 'P0001', 'FORBIDDEN', 'seller cannot read field intelligence');

select set_config('request.jwt.claim.sub', :'administrator_id', true);
select throws_ok(format($sql$select api.get_field_intelligence(
  'stock','2199-01-01','2199-01-07',null,null,null,null,null,'America/Sao_Paulo'
)$sql$), 'P0001', 'FORBIDDEN', 'administrator has no implicit commercial access');

select set_config('request.jwt.claim.sub', :'blocked_id', true);
select throws_ok(format($sql$select api.get_field_intelligence(
  'stock','2199-01-01','2199-01-07',null,null,null,null,null,'America/Sao_Paulo'
)$sql$), 'P0001', 'FORBIDDEN', 'blocked actor cannot read field intelligence');

select set_config('request.jwt.claim.sub', :'manager_a_id', true);
select throws_ok(format($sql$select api.get_field_intelligence(
  'stock','2199-01-01','2199-01-07',%L,null,null,null,null,'America/Sao_Paulo'
)$sql$, :'seller_b_id'), 'P0001', 'FORBIDDEN', 'manager cannot filter another seller');
select throws_ok($$select api.get_field_intelligence(
  'stock','2199-01-01','2199-01-07',null,null,'11111111-1111-4111-8111-111111111111',null,null,'America/Sao_Paulo'
)$$, 'P0001', 'VALIDATION_FAILED', 'competitor filter is rejected outside prices/actions');
select throws_ok($$select api.get_field_intelligence(
  'prices','2199-01-01','2199-01-07',null,null,null,'other',null,'America/Sao_Paulo'
)$$, 'P0001', 'VALIDATION_FAILED', 'action type is rejected outside actions');
select throws_ok($$select api.get_field_intelligence(
  'results','2199-01-01','2199-01-07',null,null,null,null,'not-a-cursor','America/Sao_Paulo'
)$$, 'P0001', 'VALIDATION_FAILED', 'malformed cursor is rejected');
reset role;

select * from finish();
rollback;
