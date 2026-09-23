begin;

select plan(47);

select has_table('api', 'parameter_values', 'parameter value catalog exists');
select has_table('api', 'competitor_price_reports', 'competitor price report table exists');
select has_table('api', 'competitor_prices', 'competitor quotation table exists');
select has_function('api', 'save_visit_competitor_prices', array['uuid', 'uuid', 'jsonb'], 'direct price wrapper exists');
select ok(has_function_privilege('authenticated', 'api.save_visit_competitor_prices(uuid,uuid,jsonb)', 'EXECUTE'), 'authenticated can execute price wrapper');
select ok(not has_function_privilege('anon', 'api.save_visit_competitor_prices(uuid,uuid,jsonb)', 'EXECUTE'), 'anon cannot save prices');
select ok(not has_table_privilege('authenticated', 'api.parameter_values', 'SELECT'), 'authenticated cannot read catalog directly');
select ok(not has_table_privilege('authenticated', 'api.competitor_price_reports', 'SELECT'), 'authenticated cannot read reports directly');
select ok(not has_table_privilege('authenticated', 'api.competitor_prices', 'SELECT'), 'authenticated cannot read quotations directly');
select ok(not has_function_privilege('authenticated', 'private.get_visit_competitor_prices_result(uuid)', 'EXECUTE'), 'authenticated cannot execute private price reader');
select ok(not has_function_privilege('authenticated', 'private.apply_visit_competitor_prices_saved(uuid,jsonb)', 'EXECUTE'), 'authenticated cannot execute private price writer');
select ok(has_function_privilege('cirne_sync_executor', 'private.get_visit_competitor_prices_result(uuid)', 'EXECUTE'), 'sync executor can read canonical price result');
select ok(has_function_privilege('cirne_sync_executor', 'private.apply_visit_competitor_prices_saved(uuid,jsonb)', 'EXECUTE'), 'sync executor can apply prices');
select is((select count(*)::integer from api.parameter_values), 0, 'migration does not publish AB-02 values');
select has_function('api', 'get_current_competitor_price_parameters', array['timestamp with time zone'], 'current price catalog wrapper exists');
select ok(has_function_privilege('authenticated', 'api.get_current_competitor_price_parameters(timestamptz)', 'EXECUTE'), 'authenticated can load the published catalog');
select ok(not has_function_privilege('anon', 'api.get_current_competitor_price_parameters(timestamptz)', 'EXECUTE'), 'anon cannot load the catalog');

select id as seller_a_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'seller_a' \gset
select id as seller_b_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'seller_b' \gset
select id as manager_a_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'manager_a' \gset
select id as administrator_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'administrator' \gset

update api.parameter_sets set status = 'retired' where status = 'published';
insert into api.parameter_sets (id, version, status, valid_from)
values ('90000000-0000-4000-8000-000000000099', 99, 'draft', '2099-01-01T00:00:00Z');
insert into api.parameter_values (id, parameter_set_id, category, code, label, sort_order) values
  ('31000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000099', 'competitor', 'synthetic_competitor', 'Concorrente Sintetico', 1),
  ('31000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000099', 'competitor_price_technology', 'synthetic_technology', 'Tecnologia Sintetica', 1),
  ('31000000-0000-4000-8000-000000000003', '90000000-0000-4000-8000-000000000099', 'competitor_price_condition', 'synthetic_condition', 'Condicao Sintetica', 1),
  ('31000000-0000-4000-8000-000000000004', '90000000-0000-4000-8000-000000000099', 'competitor_price_unavailable_reason', 'synthetic_reason', 'Motivo Sintetico', 1);
update api.parameter_sets set status = 'published', published_at = '2099-01-01T00:00:00Z',
  published_by = :'administrator_id' where id = '90000000-0000-4000-8000-000000000099';

set local role authenticated;
select set_config('request.jwt.claim.sub', :'seller_a_id', true);
select api.get_current_competitor_price_parameters('2099-09-21T12:00:00Z') as price_catalog \gset
reset role;
select is((:'price_catalog')::jsonb ->> 'parameterSetId', '90000000-0000-4000-8000-000000000099', 'catalog resolves the set valid for the route instant');
select is(
  jsonb_array_length((:'price_catalog')::jsonb #> '{values,competitors}')
  + jsonb_array_length((:'price_catalog')::jsonb #> '{values,technologies}')
  + jsonb_array_length((:'price_catalog')::jsonb #> '{values,conditions}')
  + jsonb_array_length((:'price_catalog')::jsonb #> '{values,unavailableReasons}'),
  4,
  'catalog groups every synthetic value into its contract category'
);

insert into api.parameter_sets (id, version, status, valid_from)
values ('90000000-0000-4000-8000-000000000100', 100, 'draft', '2100-01-01T00:00:00Z');
insert into api.parameter_values (id, parameter_set_id, category, code, label)
values ('31000000-0000-4000-8000-000000000005', '90000000-0000-4000-8000-000000000100',
  'competitor', 'wrong_set_competitor', 'Concorrente de Outro Conjunto');

select throws_ok(
  $$update api.parameter_values set label = 'Alterado' where id = '31000000-0000-4000-8000-000000000001'$$,
  'P0001', 'VERSION_CONFLICT', 'published parameter values are immutable');
select throws_ok(
  $$update api.parameter_values
      set parameter_set_id = '90000000-0000-4000-8000-000000000100'
      where id = '31000000-0000-4000-8000-000000000004'$$,
  'P0001', 'VERSION_CONFLICT', 'published parameter values cannot be moved into a draft set');

insert into api.clients (id, external_reference, name, address, portfolio_reference)
values ('10000000-0000-4000-8000-000000000099', 'PRICE-099', 'Cliente Precos', 'Endereco sintetico', 'CARTEIRA-PRECOS')
on conflict (id) do update set name = excluded.name;

set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_a_id', true);
select api.create_route_draft(jsonb_build_object(
  'schemaVersion', 1, 'serviceDate', '2099-09-21', 'sellerId', :'seller_a_id',
  'stops', jsonb_build_array(jsonb_build_object(
    'clientId', '10000000-0000-4000-8000-000000000099', 'plannedOrder', 1, 'priority', 0
  ))
)) as price_route \gset
reset role;
select (:'price_route')::jsonb ->> 'routeId' as price_route_id \gset
select id as price_stop_id from api.route_version_stops
where route_version_id = ((:'price_route')::jsonb ->> 'routeVersionId')::uuid \gset
set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_a_id', true);
select api.publish_route(:'price_route_id'::uuid, 1);
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', :'seller_a_id', true);
select jsonb_build_object(
  'eventId', '66000000-0000-4000-8000-000000000101',
  'idempotencyKey', '77000000-0000-4000-8000-000000000101',
  'operation', 'visit.started.v1', 'schemaVersion', 1, 'sequence', 1,
  'aggregateType', 'visit', 'aggregateId', '55000000-0000-4000-8000-000000000099',
  'occurredAt', '2099-09-21T12:00:00.000Z',
  'payload', jsonb_build_object(
    'offlineId', '55000000-0000-4000-8000-000000000099',
    'routeVersionStopId', :'price_stop_id',
    'deviceStartedAt', '2099-09-21T12:00:00.000Z'
  )
) as deferred_start \gset
reset role;

-- The start was captured while set 99 was current, but reaches the server only
-- after a future catalog has replaced it.
update api.parameter_sets set status = 'retired'
where id = '90000000-0000-4000-8000-000000000099';
update api.parameter_sets
set status = 'published', published_at = '2100-01-01T00:00:00Z', published_by = :'administrator_id'
where id = '90000000-0000-4000-8000-000000000100';

set local role authenticated;
select set_config('request.jwt.claim.sub', :'seller_a_id', true);
select api.get_current_competitor_price_parameters('2099-09-21T12:00:00Z') as historical_catalog \gset
select api.sync_event(
  '22000000-0000-4000-8000-000000000099', :'deferred_start'::jsonb
) as start_confirmation \gset
reset role;
select is((:'historical_catalog')::jsonb ->> 'parameterSetId',
  '90000000-0000-4000-8000-000000000099',
  'historical lookup resolves a retired catalog that was valid at the requested instant');
select is((:'start_confirmation')::jsonb ->> 'parameterSetId',
  '90000000-0000-4000-8000-000000000099',
  'delayed start confirmation exposes the exact historical parameter set');
select is((select parameter_set_id::text from api.visits
  where id = ((:'start_confirmation')::jsonb ->> 'canonicalId')::uuid),
  '90000000-0000-4000-8000-000000000099',
  'delayed start persists the historical parameter set instead of the future publication');
select jsonb_build_object('visitId', (:'start_confirmation')::jsonb ->> 'canonicalId') as started \gset

set local role authenticated;
select set_config('request.jwt.claim.sub', :'seller_a_id', true);
select api.save_visit_stock(
  '22000000-0000-4000-8000-000000000099',
  '77000000-0000-4000-8000-000000000102',
  '{"schemaVersion":1,"offlineId":"55000000-0000-4000-8000-000000000099","heliarQuantity":0,"mouraQuantity":0,"deviceSavedAt":"2099-09-21T12:01:00.000Z"}'::jsonb
);
select api.save_visit_competitor_prices(
  '22000000-0000-4000-8000-000000000099',
  '77000000-0000-4000-8000-000000000103',
  '{"schemaVersion":1,"offlineId":"55000000-0000-4000-8000-000000000099","availability":"available","quotations":[{"competitorId":"31000000-0000-4000-8000-000000000001","modelOrAmperage":"60 Ah","technologyId":"31000000-0000-4000-8000-000000000002","priceBrl":"499.90","conditionId":"31000000-0000-4000-8000-000000000003","observation":"Primeira cotacao"},{"competitorId":"31000000-0000-4000-8000-000000000001","modelOrAmperage":"70 Ah","technologyId":"31000000-0000-4000-8000-000000000002","priceBrl":"599","conditionId":"31000000-0000-4000-8000-000000000003"}],"deviceSavedAt":"2099-09-21T12:02:00.000Z"}'::jsonb
) as first_prices \gset
reset role;

select is((:'first_prices')::jsonb ->> 'visitId', (:'started')::jsonb ->> 'visitId', 'prices resolve the canonical visit');
select is((:'first_prices')::jsonb ->> 'availability', 'available', 'available response is explicit');
select is(jsonb_array_length((:'first_prices')::jsonb -> 'quotationIds'), 2, 'two distinct quotation rows are returned');
select is((select count(*)::integer from api.competitor_price_reports where visit_id = ((:'started')::jsonb ->> 'visitId')::uuid), 1, 'visit has one price report');
select is((select count(*)::integer from api.competitor_prices where report_id = ((:'first_prices')::jsonb ->> 'reportId')::uuid), 2, 'both quotations are persisted');
select is((select price_brl::text from api.competitor_prices where report_id = ((:'first_prices')::jsonb ->> 'reportId')::uuid order by ordinal limit 1), '499.90', 'decimal BRL is stored without implicit rounding');
select is((select count(*)::integer from private.sync_events where operation = 'visit.prices.saved.v1'), 1, 'price save confirms one sync intention');
select is((select count(*)::integer from private.audit_events where action = 'visit.prices.saved.v1'), 1, 'price save appends one audit fact');

set local role authenticated;
select set_config('request.jwt.claim.sub', :'seller_a_id', true);
select is(api.save_visit_competitor_prices(
  '22000000-0000-4000-8000-000000000099', '77000000-0000-4000-8000-000000000103',
  '{"schemaVersion":1,"offlineId":"55000000-0000-4000-8000-000000000099","availability":"available","quotations":[{"competitorId":"31000000-0000-4000-8000-000000000001","modelOrAmperage":"60 Ah","technologyId":"31000000-0000-4000-8000-000000000002","priceBrl":"499.90","conditionId":"31000000-0000-4000-8000-000000000003","observation":"Primeira cotacao"},{"competitorId":"31000000-0000-4000-8000-000000000001","modelOrAmperage":"70 Ah","technologyId":"31000000-0000-4000-8000-000000000002","priceBrl":"599","conditionId":"31000000-0000-4000-8000-000000000003"}],"deviceSavedAt":"2099-09-21T12:02:00.000Z"}'::jsonb
), (:'first_prices')::jsonb, 'exact replay returns the original result');
select throws_ok(
  $$select api.save_visit_competitor_prices('22000000-0000-4000-8000-000000000099',
    '77000000-0000-4000-8000-000000000103',
    '{"schemaVersion":1,"offlineId":"55000000-0000-4000-8000-000000000099","availability":"unavailable","unavailableReasonId":"31000000-0000-4000-8000-000000000004","deviceSavedAt":"2099-09-21T12:02:00.000Z"}'::jsonb)$$,
  'P0001', 'IDEMPOTENCY_KEY_REUSED', 'same key with divergent prices is rejected');
select throws_ok(
  $$select api.save_visit_competitor_prices('22000000-0000-4000-8000-000000000099',
    '77000000-0000-4000-8000-000000000104',
    '{"schemaVersion":1,"offlineId":"55000000-0000-4000-8000-000000000099","availability":"available","quotations":[{"competitorId":"31000000-0000-4000-8000-000000000001","modelOrAmperage":"60 Ah","technologyId":"31000000-0000-4000-8000-000000000002","priceBrl":"0","conditionId":"31000000-0000-4000-8000-000000000003"}],"deviceSavedAt":"2099-09-21T12:03:00.000Z"}'::jsonb)$$,
  'P0001', 'VALIDATION_FAILED', 'zero price is rejected');
select throws_ok(
  $$select api.save_visit_competitor_prices('22000000-0000-4000-8000-000000000099',
    '77000000-0000-4000-8000-000000000105',
    '{"schemaVersion":1,"offlineId":"55000000-0000-4000-8000-000000000099","availability":"available","quotations":[{"competitorId":"31000000-0000-4000-8000-000000000005","modelOrAmperage":"60 Ah","technologyId":"31000000-0000-4000-8000-000000000002","priceBrl":"499.90","conditionId":"31000000-0000-4000-8000-000000000003"}],"deviceSavedAt":"2099-09-21T12:03:00.000Z"}'::jsonb)$$,
  'P0001', 'VALIDATION_FAILED', 'catalog value from another parameter set is rejected');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', :'seller_a_id', true);
select api.save_visit_competitor_prices(
  '22000000-0000-4000-8000-000000000099', '77000000-0000-4000-8000-000000000106',
  '{"schemaVersion":1,"offlineId":"55000000-0000-4000-8000-000000000099","availability":"unavailable","unavailableReasonId":"31000000-0000-4000-8000-000000000004","deviceSavedAt":"2099-09-21T12:04:00.000Z"}'::jsonb
) as edited_prices \gset
reset role;
select is((:'edited_prices')::jsonb ->> 'availability', 'unavailable', 'new intention can edit the response to unavailable');
select is((:'edited_prices')::jsonb ->> 'unavailableReasonId', '31000000-0000-4000-8000-000000000004', 'unavailability reason is preserved');
select is((select count(*)::integer from api.competitor_prices where report_id = ((:'first_prices')::jsonb ->> 'reportId')::uuid), 0, 'editing to unavailable removes effective quotations');
select is((select count(*)::integer from api.competitor_price_reports where visit_id = ((:'started')::jsonb ->> 'visitId')::uuid), 1, 'editing does not duplicate the report');
select is((select count(*)::integer from private.audit_events where action = 'visit.prices.saved.v1'), 2, 'editing appends a second audit fact');

set local role authenticated;
select set_config('request.jwt.claim.sub', :'seller_a_id', true);
select is(api.save_visit_competitor_prices(
  '22000000-0000-4000-8000-000000000099', '77000000-0000-4000-8000-000000000103',
  '{"schemaVersion":1,"offlineId":"55000000-0000-4000-8000-000000000099","availability":"available","quotations":[{"competitorId":"31000000-0000-4000-8000-000000000001","modelOrAmperage":"60 Ah","technologyId":"31000000-0000-4000-8000-000000000002","priceBrl":"499.90","conditionId":"31000000-0000-4000-8000-000000000003","observation":"Primeira cotacao"},{"competitorId":"31000000-0000-4000-8000-000000000001","modelOrAmperage":"70 Ah","technologyId":"31000000-0000-4000-8000-000000000002","priceBrl":"599","conditionId":"31000000-0000-4000-8000-000000000003"}],"deviceSavedAt":"2099-09-21T12:02:00.000Z"}'::jsonb
), (:'first_prices')::jsonb, 'old replay remains byte-equivalent after a later edit');
reset role;
select is((select availability from api.competitor_price_reports where visit_id = ((:'started')::jsonb ->> 'visitId')::uuid), 'unavailable', 'old replay does not overwrite the effective response');

set local role authenticated;
select set_config('request.jwt.claim.sub', :'seller_b_id', true);
select throws_ok(
  $$select api.save_visit_competitor_prices('22000000-0000-4000-8000-000000000099',
    '77000000-0000-4000-8000-000000000107',
    '{"schemaVersion":1,"offlineId":"55000000-0000-4000-8000-000000000099","availability":"unavailable","unavailableReasonId":"31000000-0000-4000-8000-000000000004","deviceSavedAt":"2099-09-21T12:05:00.000Z"}'::jsonb)$$,
  'P0001', 'VALIDATION_FAILED', 'another seller receives a non-enumerating denial');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_a_id', true);
select throws_ok(
  $$select api.save_visit_competitor_prices('22000000-0000-4000-8000-000000000099',
    '77000000-0000-4000-8000-000000000108',
    '{"schemaVersion":1,"offlineId":"55000000-0000-4000-8000-000000000099","availability":"unavailable","unavailableReasonId":"31000000-0000-4000-8000-000000000004","deviceSavedAt":"2099-09-21T12:05:00.000Z"}'::jsonb)$$,
  'P0001', 'FORBIDDEN', 'manager cannot save seller prices');
reset role;

select is((select max(sequence) from private.sync_events where operation = 'visit.prices.saved.v1'), 4, 'price edits preserve aggregate sequence');
select is((select count(*)::integer from private.competitor_price_receipts), 2, 'one immutable result receipt is kept per successful intention');

select * from finish();
rollback;
