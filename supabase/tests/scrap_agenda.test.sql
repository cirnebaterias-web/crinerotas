begin;

select plan(26);

select has_function(
  'api', 'get_scrap_agenda',
  array['date','date','text','text','uuid','uuid','text'],
  'guarded scrap agenda reader exists'
);
select ok(has_function_privilege(
  'authenticated',
  'api.get_scrap_agenda(date,date,text,text,uuid,uuid,text)',
  'EXECUTE'
), 'authenticated can execute the guarded reader');
select ok(not has_function_privilege(
  'anon',
  'api.get_scrap_agenda(date,date,text,text,uuid,uuid,text)',
  'EXECUTE'
), 'anon cannot execute the agenda reader');
select ok(not has_table_privilege('authenticated', 'api.pickup_schedules', 'SELECT'),
  'authenticated cannot select pickup schedules directly');
select has_index('api', 'pickup_schedules', 'pickup_schedules_agenda_order',
  'agenda has a stable-order index');

select id as seller_a_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'seller_a'
  order by created_at desc limit 1 \gset
select id as seller_b_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'seller_b'
  order by created_at desc limit 1 \gset
select id as manager_a_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'manager_a'
  order by created_at desc limit 1 \gset
select id as administrator_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'administrator'
  order by created_at desc limit 1 \gset
select id as logistics_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'logistics_a'
  order by created_at desc limit 1 \gset
select id as blocked_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'blocked'
  order by created_at desc limit 1 \gset
select client_id as client_a_id from api.client_seller_scopes
  where seller_id = :'seller_a_id' and revoked_at is null order by created_at limit 1 \gset
\set client_b_id '94000000-0000-4000-8000-000000000001'
insert into api.clients(id, external_reference, name, address, status)
values (:'client_b_id', 'SYNTH-SCRAP-AGENDA-B', 'Cliente agenda B', 'Endereço sintético B', 'active');
insert into api.client_seller_scopes(id, client_id, seller_id)
values ('94000000-0000-4000-8000-000000000002', :'client_b_id', :'seller_b_id');

insert into api.pickup_schedules (
  offline_id, seller_id, device_id, client_id,
  client_name_snapshot, address_snapshot, seller_name_snapshot,
  estimated_weight_kg, desired_date, period, observation,
  requested_at, origin, status, version, created_at, updated_at
)
select
  gen_random_uuid(), :'seller_a_id', gen_random_uuid(), :'client_a_id',
  'Cliente agenda A', 'Endereço sintético A', 'Vendedor agenda A',
  1, date '2299-11-10', case when series.number % 2 = 1 then 'morning' else 'afternoon' end,
  'Pendência sintética ' || series.number,
  timestamptz '2299-11-01 10:00:00+00' + series.number * interval '1 second',
  'standalone', 'pending', 1,
  timestamptz '2299-11-01 11:00:00+00' + series.number * interval '1 second',
  timestamptz '2299-11-01 11:00:00+00' + series.number * interval '1 second'
from generate_series(1, 55) as series(number);

insert into api.pickup_schedules (
  offline_id, seller_id, device_id, client_id,
  client_name_snapshot, address_snapshot, seller_name_snapshot,
  estimated_weight_kg, desired_date, period, observation,
  requested_at, origin, status, version, created_at, updated_at
) values (
  gen_random_uuid(), :'seller_b_id', gen_random_uuid(), :'client_b_id',
  'Cliente agenda B', 'Endereço sintético B', 'Vendedor agenda B',
  99, '2299-11-10', 'morning', 'Fora do escopo A',
  '2299-11-01 09:00:00+00', 'standalone', 'pending', 1,
  '2299-11-01 09:30:00+00', '2299-11-01 09:30:00+00'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_a_id', true);
select api.get_scrap_agenda(
  '2299-11-10', '2299-11-10', 'pending', null, null, null, null
) as first_page \gset

select is(jsonb_array_length((:'first_page')::jsonb -> 'records'), 50,
  'first agenda page is capped at fifty records');
select is((:'first_page')::jsonb #>> '{indicators,records}', '55',
  'record indicator covers the complete manager-scoped set');
select is((:'first_page')::jsonb #>> '{indicators,scheduledKg}', '55',
  'scheduled kilograms cover the complete filtered set only');
select ok((:'first_page')::jsonb ->> 'nextCursor' !~ '[[:space:]=+/]',
  'agenda cursor is unpadded URL-safe base64');
select ok((:'first_page')::text !~* '(actualWeight|receivedWeight|latitude|longitude|storagePath|signedUrl|payload|idempotency)',
  'agenda response excludes collection, location, evidence and synchronization data');
select is((:'first_page')::jsonb #>> '{records,0,status}', 'pending',
  'agenda exposes only the pending state');
select is((:'first_page')::jsonb #>> '{records,0,period}', 'morning',
  'morning sorts before afternoon on the same desired date');
select ok((:'first_page')::jsonb ->> 'lastServerConfirmedAt' is not null,
  'agenda exposes the latest server confirmation');

select api.get_scrap_agenda(
  '2299-11-10', '2299-11-10', 'pending', null, null, null,
  (:'first_page')::jsonb ->> 'nextCursor'
) as second_page \gset
select is(jsonb_array_length((:'second_page')::jsonb -> 'records'), 5,
  'following nextCursor returns the remaining schedules');
select is((:'second_page')::jsonb #>> '{indicators,records}', '55',
  'indicators remain based on the full set on later pages');
select is((:'second_page')::jsonb ->> 'nextCursor', null,
  'last agenda page does not expose another cursor');

select api.get_scrap_agenda(
  '2299-11-10', '2299-11-10', 'pending', 'morning', null, null, null
) as morning_result \gset
select is((:'morning_result')::jsonb #>> '{indicators,records}', '28',
  'morning filter applies before aggregation');
select api.get_scrap_agenda(
  '2299-11-10', '2299-11-10', 'pending', null, null, :'client_a_id', null
) as client_result \gset
select is((:'client_result')::jsonb #>> '{indicators,records}', '55',
  'client filter preserves the manager-scoped schedules');

select set_config('request.jwt.claim.sub', :'seller_a_id', true);
select throws_ok(format($sql$select api.get_scrap_agenda(
  '2299-11-10','2299-11-10','pending',null,null,null,null
)$sql$), 'P0001', 'FORBIDDEN', 'seller cannot read the management agenda');

select set_config('request.jwt.claim.sub', :'blocked_id', true);
select throws_ok(format($sql$select api.get_scrap_agenda(
  '2299-11-10','2299-11-10','pending',null,null,null,null
)$sql$), 'P0001', 'FORBIDDEN', 'blocked actor cannot read the agenda');

select set_config('request.jwt.claim.sub', :'manager_a_id', true);
select throws_ok(format($sql$select api.get_scrap_agenda(
  '2299-11-10','2299-11-10','pending',null,%L,null,null
)$sql$, :'seller_b_id'), 'P0001', 'FORBIDDEN', 'manager cannot filter another seller');
select throws_ok($$select api.get_scrap_agenda(
  '2299-11-10','2299-11-10','completed',null,null,null,null
)$$, 'P0001', 'VALIDATION_FAILED', 'state beyond pending is rejected');
select throws_ok($$select api.get_scrap_agenda(
  '2299-11-10','2299-11-10','pending',null,null,null,'not-a-cursor'
)$$, 'P0001', 'VALIDATION_FAILED', 'malformed cursor is rejected');

select set_config('request.jwt.claim.sub', :'administrator_id', true);
select api.get_scrap_agenda(
  '2299-11-10','2299-11-10','pending',null,null,null,null
) as administrator_result \gset
select is((:'administrator_result')::jsonb #>> '{indicators,records}', '56',
  'administrator retains the previously approved operational read');

select set_config('request.jwt.claim.sub', :'logistics_id', true);
select api.get_scrap_agenda(
  '2299-11-10','2299-11-10','pending',null,null,null,null
) as logistics_result \gset
select is((:'logistics_result')::jsonb #>> '{indicators,records}', '56',
  'logistics retains the previously approved operational read');

select set_config('request.jwt.claim.sub', :'manager_a_id', true);
select is((:'first_page')::jsonb #>> '{filters,status}', 'pending',
  'normalized filters make the only active state explicit');
reset role;

select * from finish();
rollback;
