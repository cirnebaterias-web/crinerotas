begin;

grant create on schema api, private to cirne_field_intelligence_executor;

do $visit_index_ownership$
begin
  execute pg_catalog.format('grant cirne_visit_executor to %I with set true granted by current_user', current_user);
end
$visit_index_ownership$;
grant create on schema api to cirne_visit_executor;
set local role cirne_visit_executor;
create index visits_pilot_metrics_idx on api.visits (
  (context_snapshot #>> '{route,serviceDate}') desc,
  server_completed_at desc,
  id desc
) include (seller_id, client_id)
where status = 'completed'
  and device_completed_at is not null
  and server_completed_at is not null;
reset role;
revoke create on schema api from cirne_visit_executor;
do $visit_index_ownership$
begin
  execute pg_catalog.format('revoke cirne_visit_executor from %I granted by current_user', current_user);
end
$visit_index_ownership$;

create function private.get_pilot_metrics(
  p_from date,
  p_to date,
  p_seller_id uuid,
  p_client_id uuid,
  p_cursor text,
  p_operational_time_zone text
)
returns jsonb language plpgsql stable security definer set search_path = '' as $function$
declare
  identity_document jsonb := private.resolve_current_identity();
  generated_at timestamptz := clock_timestamp();
  cursor_payload text;
  cursor_service_date date;
  cursor_confirmed_at timestamptz;
  cursor_visit_id uuid;
  totals_document jsonb;
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
  if p_from is null or p_to is null or p_from > p_to or p_operational_time_zone is null then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  perform generated_at at time zone p_operational_time_zone;
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

  with filtered as (
    select
      base.id as visit_id, base.seller_id, base.client_id,
      (base.context_snapshot #>> '{route,serviceDate}')::date as service_date,
      base.context_snapshot #>> '{seller,displayName}' as seller_name,
      base.context_snapshot #>> '{client,name}' as client_name,
      base.device_completed_at, base.server_completed_at,
      exists (select 1 from api.stock_snapshots stock where stock.visit_id = base.id)
        and exists (select 1 from api.competitor_price_reports price where price.visit_id = base.id)
        and exists (select 1 from api.visit_commercial_action_reports action where action.visit_id = base.id)
        and exists (select 1 from api.scrap_reports scrap where scrap.visit_id = base.id)
        as required_complete,
      exists (select 1 from api.scrap_reports scrap where scrap.visit_id = base.id)
        as scrap_reported,
      exists (select 1 from api.visit_commercial_action_reports action where action.visit_id = base.id)
        as commercial_action_reported,
      case
        when base.device_completed_at > base.server_completed_at then 'clock_suspicious'
        when generated_at < base.device_completed_at + interval '24 hours' then 'window_open'
        when base.server_completed_at <= base.device_completed_at + interval '24 hours' then 'within_24h'
        else 'outside_24h'
      end as sync_24h
    from api.visits base
    where base.status = 'completed'
      and base.device_completed_at is not null and base.server_completed_at is not null
      and (base.context_snapshot #>> '{route,serviceDate}') between p_from::text and p_to::text
      and exists (select 1 from jsonb_array_elements_text(identity_document -> 'scopeIds') scope(id)
        where scope.id::uuid = base.seller_id)
      and (p_seller_id is null or base.seller_id = p_seller_id)
      and (p_client_id is null or base.client_id = p_client_id)
  ), exceptions as (
    select filtered.visit_id, filtered.seller_id, filtered.client_id, filtered.service_date,
      filtered.seller_name, filtered.client_name, filtered.device_completed_at,
      filtered.server_completed_at, filtered.required_complete, filtered.scrap_reported,
      filtered.commercial_action_reported, filtered.sync_24h
    from filtered
    where not filtered.required_complete or not filtered.scrap_reported
      or not filtered.commercial_action_reported or filtered.sync_24h <> 'within_24h'
  ), page as (
    select exceptions.visit_id, exceptions.seller_id, exceptions.client_id, exceptions.service_date,
      exceptions.seller_name, exceptions.client_name, exceptions.device_completed_at,
      exceptions.server_completed_at, exceptions.required_complete, exceptions.scrap_reported,
      exceptions.commercial_action_reported, exceptions.sync_24h
    from exceptions
    where p_cursor is null or (exceptions.service_date, exceptions.server_completed_at, exceptions.visit_id) <
      (cursor_service_date, cursor_confirmed_at, cursor_visit_id)
    order by exceptions.service_date desc, exceptions.server_completed_at desc, exceptions.visit_id desc
    limit page_size + 1
  )
  select
    jsonb_build_object(
      'completed', count(*)::integer,
      'requiredComplete', count(*) filter (where filtered.required_complete)::integer,
      'scrapReported', count(*) filter (where filtered.scrap_reported)::integer,
      'commercialActionReported', count(*) filter (where filtered.commercial_action_reported)::integer,
      'syncWithin24h', count(*) filter (where filtered.sync_24h = 'within_24h')::integer,
      'syncEligible', count(*) filter (where filtered.sync_24h in ('within_24h', 'outside_24h'))::integer,
      'windowOpen', count(*) filter (where filtered.sync_24h = 'window_open')::integer,
      'clockSuspicious', count(*) filter (where filtered.sync_24h = 'clock_suspicious')::integer
    ),
    max(filtered.server_completed_at),
    coalesce((select jsonb_agg(jsonb_build_object(
      'visitId', row.visit_id,
      'serviceDate', row.service_date,
      'seller', jsonb_build_object('id', row.seller_id, 'displayName', row.seller_name),
      'client', jsonb_build_object('id', row.client_id, 'name', row.client_name),
      'deviceCompletedAt', row.device_completed_at,
      'serverCompletedAt', row.server_completed_at,
      'checks', jsonb_build_object(
        'requiredComplete', row.required_complete,
        'scrapReported', row.scrap_reported,
        'commercialActionReported', row.commercial_action_reported,
        'sync24h', row.sync_24h
      )
    ) order by row.service_date desc, row.server_completed_at desc, row.visit_id desc)
      from (select page.visit_id, page.seller_id, page.client_id, page.service_date,
        page.seller_name, page.client_name, page.device_completed_at, page.server_completed_at,
        page.required_complete, page.scrap_reported, page.commercial_action_reported, page.sync_24h
        from page limit page_size) row), '[]'::jsonb),
    case when (select count(*) from page) > page_size then (
      select private.field_intelligence_cursor(row.service_date, row.server_completed_at, row.visit_id)
      from (select page.service_date, page.server_completed_at, page.visit_id from page limit page_size) row
      order by row.service_date, row.server_completed_at, row.visit_id limit 1
    ) end
  into totals_document, last_confirmed_at, records_document, next_cursor
  from filtered;

  return jsonb_build_object(
    'generatedAt', generated_at,
    'lastServerConfirmedAt', last_confirmed_at,
    'totals', totals_document,
    'records', records_document,
    'nextCursor', next_cursor
  );
end
$function$;

create function api.get_pilot_metrics(
  p_from date,
  p_to date,
  p_seller_id uuid default null,
  p_client_id uuid default null,
  p_cursor text default null,
  p_operational_time_zone text default 'America/Sao_Paulo'
)
returns jsonb language sql stable security definer set search_path = '' as $function$
  select private.get_pilot_metrics(
    p_from, p_to, p_seller_id, p_client_id, p_cursor, p_operational_time_zone
  );
$function$;

comment on function api.get_pilot_metrics(date, date, uuid, uuid, text, text) is
  'Projeta contadores e exceções server-side do piloto sob escopo gerencial; fontes externas não são inferidas.';

do $ownership$
begin
  execute pg_catalog.format('grant cirne_field_intelligence_executor to %I with set true granted by current_user', current_user);
end
$ownership$;
alter function private.get_pilot_metrics(date, date, uuid, uuid, text, text)
  owner to cirne_field_intelligence_executor;
alter function api.get_pilot_metrics(date, date, uuid, uuid, text, text)
  owner to cirne_field_intelligence_executor;
set local role cirne_field_intelligence_executor;
revoke all on function private.get_pilot_metrics(date, date, uuid, uuid, text, text)
  from public, anon, authenticated;
revoke all on function api.get_pilot_metrics(date, date, uuid, uuid, text, text) from public, anon;
grant execute on function api.get_pilot_metrics(date, date, uuid, uuid, text, text) to authenticated;
reset role;
revoke create on schema api, private from cirne_field_intelligence_executor;
do $ownership$
begin
  execute pg_catalog.format('revoke cirne_field_intelligence_executor from %I granted by current_user', current_user);
end
$ownership$;

commit;
