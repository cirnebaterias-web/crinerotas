begin;

create role cirne_field_intelligence_executor
  nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;

grant usage, create on schema api, private to cirne_field_intelligence_executor;

do $identity_ownership$
begin
  execute pg_catalog.format('grant cirne_identity_executor to %I with set true granted by current_user', current_user);
end
$identity_ownership$;
set local role cirne_identity_executor;
grant execute on function private.resolve_current_identity() to cirne_field_intelligence_executor;
reset role;
do $identity_ownership$
begin
  execute pg_catalog.format('revoke cirne_identity_executor from %I granted by current_user', current_user);
end
$identity_ownership$;

do $visit_ownership$
begin
  execute pg_catalog.format('grant cirne_visit_executor to %I with set true granted by current_user', current_user);
end
$visit_ownership$;
set local role cirne_visit_executor;
grant select on table api.visits, api.stock_snapshots, api.competitor_price_reports,
  api.competitor_prices, api.parameter_values to cirne_field_intelligence_executor;
create policy visits_field_intelligence_read on api.visits
  for select to cirne_field_intelligence_executor using (true);
create policy stock_field_intelligence_read on api.stock_snapshots
  for select to cirne_field_intelligence_executor using (true);
create policy price_reports_field_intelligence_read on api.competitor_price_reports
  for select to cirne_field_intelligence_executor using (true);
create policy prices_field_intelligence_read on api.competitor_prices
  for select to cirne_field_intelligence_executor using (true);
create policy parameters_field_intelligence_read on api.parameter_values
  for select to cirne_field_intelligence_executor using (true);
reset role;
do $visit_ownership$
begin
  execute pg_catalog.format('revoke cirne_visit_executor from %I granted by current_user', current_user);
end
$visit_ownership$;

grant select on table api.visit_commercial_action_reports,
  api.visit_competitor_commercial_actions, api.scrap_reports,
  api.scrap_collections, api.pickup_schedules to cirne_field_intelligence_executor;
create policy action_reports_field_intelligence_read on api.visit_commercial_action_reports
  for select to cirne_field_intelligence_executor using (true);
create policy actions_field_intelligence_read on api.visit_competitor_commercial_actions
  for select to cirne_field_intelligence_executor using (true);
create policy scrap_reports_field_intelligence_read on api.scrap_reports
  for select to cirne_field_intelligence_executor using (true);
create policy collections_field_intelligence_read on api.scrap_collections
  for select to cirne_field_intelligence_executor using (true);
create policy schedules_field_intelligence_read on api.pickup_schedules
  for select to cirne_field_intelligence_executor using (true);

create view api.field_intelligence_v with (security_invoker = true) as
select
  visit.id as visit_id,
  visit.seller_id,
  visit.client_id,
  (visit.context_snapshot #>> '{route,serviceDate}')::date as service_date,
  visit.context_snapshot #>> '{seller,displayName}' as seller_name,
  visit.context_snapshot #>> '{client,name}' as client_name,
  visit.status,
  visit.device_started_at,
  visit.server_started_at,
  visit.device_completed_at,
  visit.server_completed_at
from api.visits visit;

revoke all on table api.field_intelligence_v from public, anon, authenticated;
grant select on table api.field_intelligence_v to cirne_field_intelligence_executor;

create function private.field_intelligence_cursor(
  p_service_date date, p_confirmed_at timestamptz, p_visit_id uuid
)
returns text language sql immutable set search_path = '' as $function$
  select replace(replace(rtrim(translate(encode(convert_to(
    p_service_date::text || '|' || p_confirmed_at::text || '|' || p_visit_id::text,
    'UTF8'
  ), 'base64'), E'\n\r', ''), '='), '+', '-'), '/', '_');
$function$;

create function private.get_field_intelligence(
  p_section text,
  p_from date,
  p_to date,
  p_seller_id uuid,
  p_client_id uuid,
  p_competitor_id uuid,
  p_action_type text,
  p_cursor text,
  p_operational_time_zone text
)
returns jsonb language plpgsql stable security definer set search_path = '' as $function$
declare
  identity_document jsonb := private.resolve_current_identity();
  cursor_payload text;
  cursor_service_date date;
  cursor_confirmed_at timestamptz;
  cursor_visit_id uuid;
  generated_at timestamptz := clock_timestamp();
  filters_document jsonb;
  indicators_document jsonb;
  records_document jsonb := '[]'::jsonb;
  last_confirmed_at timestamptz;
  next_cursor text;
  page_size integer := 50;
begin
  if identity_document is null
     or not (identity_document -> 'roles' @> '["manager"]'::jsonb)
     or not (identity_document -> 'capabilities' @> '["route.read_scoped"]'::jsonb)
     or jsonb_array_length(identity_document -> 'scopeIds') = 0 then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;
  if p_section not in ('stock', 'prices', 'actions', 'scrap', 'results')
     or p_from is null or p_to is null or p_from > p_to
     or p_operational_time_zone is null
     or (p_competitor_id is not null and p_section not in ('prices', 'actions'))
     or (p_action_type is not null and p_section <> 'actions')
     or (p_action_type is not null and p_action_type not in (
       'differentiated_price', 'seller_or_driver_incentive', 'retailer_incentive', 'purchase_combo', 'other'
     )) then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  perform clock_timestamp() at time zone p_operational_time_zone;
  if p_seller_id is not null and not exists (
    select 1 from jsonb_array_elements_text(identity_document -> 'scopeIds') scope(id)
    where scope.id::uuid = p_seller_id
  ) then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;
  if p_cursor is not null then
    begin
      cursor_payload := convert_from(decode(
        rpad(translate(p_cursor, '-_', '+/'), ((length(p_cursor) + 3) / 4) * 4, '='), 'base64'
      ), 'UTF8');
      cursor_service_date := split_part(cursor_payload, '|', 1)::date;
      cursor_confirmed_at := split_part(cursor_payload, '|', 2)::timestamptz;
      cursor_visit_id := split_part(cursor_payload, '|', 3)::uuid;
      if split_part(cursor_payload, '|', 4) <> '' then raise invalid_text_representation; end if;
    exception when others then
      raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
    end;
  end if;

  filters_document := jsonb_strip_nulls(jsonb_build_object(
    'section', p_section, 'from', p_from, 'to', p_to,
    'sellerId', p_seller_id, 'clientId', p_client_id,
    'competitorId', p_competitor_id, 'actionType', p_action_type
  ));

  if p_section = 'stock' then
    with filtered as (
      select base.*, stock.id as record_id, stock.server_saved_at as confirmed_at,
        stock.heliar_quantity, stock.moura_quantity,
        coalesce(stock.details -> 'ownLines', '[]'::jsonb) as own_lines,
        coalesce(stock.details -> 'competitorLines', '[]'::jsonb) as competitor_lines
      from api.field_intelligence_v base
      join api.stock_snapshots stock on stock.visit_id = base.visit_id
      where base.service_date between p_from and p_to
        and exists (select 1 from jsonb_array_elements_text(identity_document -> 'scopeIds') scope(id)
          where scope.id::uuid = base.seller_id)
        and (p_seller_id is null or base.seller_id = p_seller_id)
        and (p_client_id is null or base.client_id = p_client_id)
    ), page as (
      select * from filtered
      where p_cursor is null or (service_date, confirmed_at, visit_id) <
        (cursor_service_date, cursor_confirmed_at, cursor_visit_id)
      order by service_date desc, confirmed_at desc, visit_id desc limit page_size + 1
    )
    select
      jsonb_build_object(
        'records', count(*)::integer,
        'heliarQuantity', coalesce(sum(heliar_quantity), 0)::integer,
        'mouraQuantity', coalesce(sum(moura_quantity), 0)::integer,
        'ownLineQuantity', coalesce(sum((select sum((line ->> 'quantity')::integer)
          from jsonb_array_elements(own_lines) line)), 0)::integer,
        'competitorLineQuantity', coalesce(sum((select sum((line ->> 'quantity')::integer)
          from jsonb_array_elements(competitor_lines) line)), 0)::integer
      ),
      max(confirmed_at),
      coalesce((select jsonb_agg(jsonb_build_object(
        'recordId', row.record_id, 'visitId', row.visit_id, 'serviceDate', row.service_date,
        'seller', jsonb_build_object('id', row.seller_id, 'name', row.seller_name),
        'client', jsonb_build_object('id', row.client_id, 'name', row.client_name),
        'confirmedAt', row.confirmed_at, 'heliarQuantity', row.heliar_quantity,
        'mouraQuantity', row.moura_quantity, 'ownLines', row.own_lines,
        'competitorLines', row.competitor_lines
      ) order by row.service_date desc, row.confirmed_at desc, row.visit_id desc)
        from (select * from page limit page_size) row), '[]'::jsonb),
      case when (select count(*) from page) > page_size then (
        select private.field_intelligence_cursor(row.service_date, row.confirmed_at, row.visit_id)
        from (select * from page limit page_size) row
        order by row.service_date, row.confirmed_at, row.visit_id limit 1
      ) end
    into indicators_document, last_confirmed_at, records_document, next_cursor from filtered;

  elsif p_section = 'prices' then
    with filtered as (
      select base.*, report.id as record_id, report.server_saved_at as confirmed_at,
        report.availability,
        case when reason.id is null then null else jsonb_build_object('id', reason.id, 'label', reason.label) end as unavailable_reason,
        coalesce((select jsonb_agg(jsonb_build_object(
          'id', price.id,
          'competitor', jsonb_build_object('id', price.competitor_id, 'label', competitor.label),
          'modelOrAmperage', price.model_or_amperage,
          'technology', jsonb_build_object('id', price.technology_id, 'label', technology.label),
          'priceBrl', price.price_brl::text,
          'condition', jsonb_build_object('id', price.condition_id, 'label', condition.label),
          'observation', price.observation
        ) order by price.ordinal)
          from api.competitor_prices price
          join api.parameter_values competitor on competitor.id = price.competitor_id
          join api.parameter_values technology on technology.id = price.technology_id
          join api.parameter_values condition on condition.id = price.condition_id
          where price.report_id = report.id
            and (p_competitor_id is null or price.competitor_id = p_competitor_id)), '[]'::jsonb) as quotations
      from api.field_intelligence_v base
      join api.competitor_price_reports report on report.visit_id = base.visit_id
      left join api.parameter_values reason on reason.id = report.unavailable_reason_id
      where base.service_date between p_from and p_to
        and exists (select 1 from jsonb_array_elements_text(identity_document -> 'scopeIds') scope(id)
          where scope.id::uuid = base.seller_id)
        and (p_seller_id is null or base.seller_id = p_seller_id)
        and (p_client_id is null or base.client_id = p_client_id)
        and (p_competitor_id is null or exists (select 1 from api.competitor_prices price
          where price.report_id = report.id and price.competitor_id = p_competitor_id))
    ), page as (
      select * from filtered where p_cursor is null or (service_date, confirmed_at, visit_id) <
        (cursor_service_date, cursor_confirmed_at, cursor_visit_id)
      order by service_date desc, confirmed_at desc, visit_id desc limit page_size + 1
    )
    select jsonb_build_object(
        'records', count(*)::integer,
        'quotations', coalesce(sum(jsonb_array_length(quotations)), 0)::integer,
        'unavailableRecords', count(*) filter (where availability = 'unavailable')::integer
      ), max(confirmed_at),
      coalesce((select jsonb_agg(jsonb_build_object(
        'recordId', row.record_id, 'visitId', row.visit_id, 'serviceDate', row.service_date,
        'seller', jsonb_build_object('id', row.seller_id, 'name', row.seller_name),
        'client', jsonb_build_object('id', row.client_id, 'name', row.client_name),
        'confirmedAt', row.confirmed_at, 'availability', row.availability,
        'unavailableReason', row.unavailable_reason, 'quotations', row.quotations
      ) order by row.service_date desc, row.confirmed_at desc, row.visit_id desc)
        from (select * from page limit page_size) row), '[]'::jsonb),
      case when (select count(*) from page) > page_size then (
        select private.field_intelligence_cursor(row.service_date, row.confirmed_at, row.visit_id)
        from (select * from page limit page_size) row
        order by row.service_date, row.confirmed_at, row.visit_id limit 1
      ) end
    into indicators_document, last_confirmed_at, records_document, next_cursor from filtered;

  elsif p_section = 'actions' then
    with filtered as (
      select base.*, report.id as record_id, report.server_saved_at as confirmed_at,
        report.competitor_availability as availability,
        coalesce((select jsonb_agg(jsonb_build_object(
          'id', action.id,
          'competitor', jsonb_build_object('id', action.competitor_id, 'label', competitor.label),
          'actionType', action.action_type, 'otherType', action.other_type,
          'description', action.description, 'validFrom', action.valid_from, 'validUntil', action.valid_until
        ) order by action.ordinal)
          from api.visit_competitor_commercial_actions action
          join api.parameter_values competitor on competitor.id = action.competitor_id
          where action.report_id = report.id
            and (p_competitor_id is null or action.competitor_id = p_competitor_id)
            and (p_action_type is null or action.action_type = p_action_type)), '[]'::jsonb) as actions
      from api.field_intelligence_v base
      join api.visit_commercial_action_reports report on report.visit_id = base.visit_id
      where base.service_date between p_from and p_to
        and exists (select 1 from jsonb_array_elements_text(identity_document -> 'scopeIds') scope(id)
          where scope.id::uuid = base.seller_id)
        and (p_seller_id is null or base.seller_id = p_seller_id)
        and (p_client_id is null or base.client_id = p_client_id)
        and ((p_competitor_id is null and p_action_type is null) or exists (
          select 1 from api.visit_competitor_commercial_actions action
          where action.report_id = report.id
            and (p_competitor_id is null or action.competitor_id = p_competitor_id)
            and (p_action_type is null or action.action_type = p_action_type)
        ))
    ), page as (
      select * from filtered where p_cursor is null or (service_date, confirmed_at, visit_id) <
        (cursor_service_date, cursor_confirmed_at, cursor_visit_id)
      order by service_date desc, confirmed_at desc, visit_id desc limit page_size + 1
    )
    select jsonb_build_object(
        'records', count(*)::integer,
        'identifiedRecords', count(*) filter (where availability = 'identified')::integer,
        'actions', coalesce(sum(jsonb_array_length(actions)), 0)::integer
      ), max(confirmed_at),
      coalesce((select jsonb_agg(jsonb_build_object(
        'recordId', row.record_id, 'visitId', row.visit_id, 'serviceDate', row.service_date,
        'seller', jsonb_build_object('id', row.seller_id, 'name', row.seller_name),
        'client', jsonb_build_object('id', row.client_id, 'name', row.client_name),
        'confirmedAt', row.confirmed_at, 'availability', row.availability, 'actions', row.actions
      ) order by row.service_date desc, row.confirmed_at desc, row.visit_id desc)
        from (select * from page limit page_size) row), '[]'::jsonb),
      case when (select count(*) from page) > page_size then (
        select private.field_intelligence_cursor(row.service_date, row.confirmed_at, row.visit_id)
        from (select * from page limit page_size) row
        order by row.service_date, row.confirmed_at, row.visit_id limit 1
      ) end
    into indicators_document, last_confirmed_at, records_document, next_cursor from filtered;

  elsif p_section = 'scrap' then
    with filtered as (
      select base.*, report.id as record_id, report.updated_at as confirmed_at,
        report.availability,
        case when collection.id is null then null else jsonb_build_object(
          'id', collection.id, 'actualWeightKg', collection.actual_weight_kg::text,
          'collectedAt', collection.collected_at
        ) end as collection,
        case when schedule.id is null then null else jsonb_build_object(
          'id', schedule.id, 'estimatedWeightKg', schedule.estimated_weight_kg::text,
          'desiredDate', schedule.desired_date, 'period', schedule.period, 'status', schedule.status
        ) end as schedule,
        collection.actual_weight_kg, schedule.estimated_weight_kg
      from api.field_intelligence_v base
      join api.scrap_reports report on report.visit_id = base.visit_id
      left join api.scrap_collections collection on collection.report_id = report.id
      left join api.pickup_schedules schedule on schedule.report_id = report.id
      where base.service_date between p_from and p_to
        and exists (select 1 from jsonb_array_elements_text(identity_document -> 'scopeIds') scope(id)
          where scope.id::uuid = base.seller_id)
        and (p_seller_id is null or base.seller_id = p_seller_id)
        and (p_client_id is null or base.client_id = p_client_id)
    ), page as (
      select * from filtered where p_cursor is null or (service_date, confirmed_at, visit_id) <
        (cursor_service_date, cursor_confirmed_at, cursor_visit_id)
      order by service_date desc, confirmed_at desc, visit_id desc limit page_size + 1
    )
    select jsonb_build_object(
        'records', count(*)::integer,
        'collectedRecords', count(*) filter (where collection is not null)::integer,
        'scheduledRecords', count(*) filter (where schedule is not null)::integer,
        'collectedWeightKg', coalesce(sum(actual_weight_kg), 0)::text,
        'scheduledWeightKg', coalesce(sum(estimated_weight_kg), 0)::text
      ), max(confirmed_at),
      coalesce((select jsonb_agg(jsonb_build_object(
        'recordId', row.record_id, 'visitId', row.visit_id, 'serviceDate', row.service_date,
        'seller', jsonb_build_object('id', row.seller_id, 'name', row.seller_name),
        'client', jsonb_build_object('id', row.client_id, 'name', row.client_name),
        'confirmedAt', row.confirmed_at, 'availability', row.availability,
        'collection', row.collection, 'schedule', row.schedule
      ) order by row.service_date desc, row.confirmed_at desc, row.visit_id desc)
        from (select * from page limit page_size) row), '[]'::jsonb),
      case when (select count(*) from page) > page_size then (
        select private.field_intelligence_cursor(row.service_date, row.confirmed_at, row.visit_id)
        from (select * from page limit page_size) row
        order by row.service_date, row.confirmed_at, row.visit_id limit 1
      ) end
    into indicators_document, last_confirmed_at, records_document, next_cursor from filtered;

  else
    with filtered as (
      select base.*, base.visit_id as record_id, base.server_completed_at as confirmed_at
      from api.field_intelligence_v base
      where base.status = 'completed' and base.server_completed_at is not null
        and base.service_date between p_from and p_to
        and exists (select 1 from jsonb_array_elements_text(identity_document -> 'scopeIds') scope(id)
          where scope.id::uuid = base.seller_id)
        and (p_seller_id is null or base.seller_id = p_seller_id)
        and (p_client_id is null or base.client_id = p_client_id)
    ), page as (
      select * from filtered where p_cursor is null or (service_date, confirmed_at, visit_id) <
        (cursor_service_date, cursor_confirmed_at, cursor_visit_id)
      order by service_date desc, confirmed_at desc, visit_id desc limit page_size + 1
    )
    select jsonb_build_object('records', count(*)::integer, 'completedVisits', count(*)::integer),
      max(confirmed_at),
      coalesce((select jsonb_agg(jsonb_build_object(
        'recordId', row.record_id, 'visitId', row.visit_id, 'serviceDate', row.service_date,
        'seller', jsonb_build_object('id', row.seller_id, 'name', row.seller_name),
        'client', jsonb_build_object('id', row.client_id, 'name', row.client_name),
        'confirmedAt', row.confirmed_at, 'outcome', 'completed',
        'deviceStartedAt', row.device_started_at, 'serverStartedAt', row.server_started_at,
        'deviceCompletedAt', row.device_completed_at, 'serverCompletedAt', row.server_completed_at
      ) order by row.service_date desc, row.confirmed_at desc, row.visit_id desc)
        from (select * from page limit page_size) row), '[]'::jsonb),
      case when (select count(*) from page) > page_size then (
        select private.field_intelligence_cursor(row.service_date, row.confirmed_at, row.visit_id)
        from (select * from page limit page_size) row
        order by row.service_date, row.confirmed_at, row.visit_id limit 1
      ) end
    into indicators_document, last_confirmed_at, records_document, next_cursor from filtered;
  end if;

  return jsonb_build_object(
    'schemaVersion', 1,
    'section', p_section,
    'filters', filters_document,
    'generatedAt', generated_at,
    'lastConfirmedAt', last_confirmed_at,
    'nextCursor', next_cursor,
    'serverVisibilityNote',
      convert_from(decode(
        '536f6d656e7465206661746f7320726563656269646f73206520636f6e6669726d61646f732070656c6f207365727669646f7220657374c3a36f20696e636c75c3ad646f733b20636f6e7465c3ba646f2061696e6461206170656e6173206e6f2061706172656c686f206ec3a36f20c3a920636f6e68656369646f2e',
        'hex'
      ), 'UTF8'),
    'indicators', indicators_document,
    'records', records_document
  );
end
$function$;

create function api.get_field_intelligence(
  p_section text,
  p_from date,
  p_to date,
  p_seller_id uuid default null,
  p_client_id uuid default null,
  p_competitor_id uuid default null,
  p_action_type text default null,
  p_cursor text default null,
  p_operational_time_zone text default 'America/Sao_Paulo'
)
returns jsonb language sql stable security definer set search_path = '' as $function$
  select private.get_field_intelligence(
    p_section, p_from, p_to, p_seller_id, p_client_id,
    p_competitor_id, p_action_type, p_cursor, p_operational_time_zone
  );
$function$;

comment on view api.field_intelligence_v is
  'Base mínima e histórica das visitas para as cinco visões gerenciais; acesso somente pelo executor dedicado.';
comment on function api.get_field_intelligence(text, date, date, uuid, uuid, uuid, text, text, text) is
  'Consulta inteligência confirmada pelo servidor com escopo gerencial, filtros estritos e paginação estável.';

do $ownership$
begin
  execute pg_catalog.format('grant cirne_field_intelligence_executor to %I with set true granted by current_user', current_user);
end
$ownership$;
alter view api.field_intelligence_v owner to cirne_field_intelligence_executor;
alter function private.field_intelligence_cursor(date, timestamptz, uuid) owner to cirne_field_intelligence_executor;
alter function private.get_field_intelligence(text, date, date, uuid, uuid, uuid, text, text, text)
  owner to cirne_field_intelligence_executor;
alter function api.get_field_intelligence(text, date, date, uuid, uuid, uuid, text, text, text)
  owner to cirne_field_intelligence_executor;
revoke create on schema api, private from cirne_field_intelligence_executor;
set local role cirne_field_intelligence_executor;
revoke all on function private.field_intelligence_cursor(date, timestamptz, uuid),
  private.get_field_intelligence(text, date, date, uuid, uuid, uuid, text, text, text)
  from public, anon, authenticated;
revoke all on function api.get_field_intelligence(text, date, date, uuid, uuid, uuid, text, text, text)
  from public, anon;
grant execute on function api.get_field_intelligence(text, date, date, uuid, uuid, uuid, text, text, text)
  to authenticated;
reset role;
do $ownership$
begin
  execute pg_catalog.format('revoke cirne_field_intelligence_executor from %I granted by current_user', current_user);
end
$ownership$;

commit;
