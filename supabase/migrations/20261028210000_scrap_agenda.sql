-- Story 4.4: authorized, filtered and paginated pending scrap agenda.
begin;

select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cirne:database:migrate'));
set local lock_timeout = '5s';

grant usage, create on schema api, private to cirne_scrap_executor;

do $ownership$
begin
  execute pg_catalog.format('grant cirne_scrap_executor to %I with set true granted by current_user', current_user);
end
$ownership$;

create index pickup_schedules_agenda_order
  on api.pickup_schedules(
    desired_date,
    (case period when 'morning' then 1 else 2 end),
    requested_at,
    id
  );

create function private.scrap_agenda_cursor(
  p_desired_date date,
  p_period text,
  p_requested_at timestamptz,
  p_schedule_id uuid
)
returns text language sql immutable set search_path = '' as $function$
  select replace(replace(rtrim(translate(encode(convert_to(
    p_desired_date::text || '|' || p_period || '|' || p_requested_at::text || '|' || p_schedule_id::text,
    'UTF8'
  ), 'base64'), E'\n\r', ''), '='), '+', '-'), '/', '_');
$function$;

alter function private.scrap_agenda_cursor(date, text, timestamptz, uuid)
  owner to cirne_scrap_executor;

create function api.get_scrap_agenda(
  p_from date,
  p_to date,
  p_status text,
  p_period text,
  p_seller_id uuid,
  p_client_id uuid,
  p_cursor text
)
returns jsonb language plpgsql stable security definer set search_path = '' as $function$
declare
  identity_document jsonb := private.scrap_identity('scrap.read_operations');
  cursor_payload text;
  cursor_desired_date date;
  cursor_period text;
  cursor_requested_at timestamptz;
  cursor_schedule_id uuid;
  generated_at timestamptz := clock_timestamp();
  filters_document jsonb;
  indicators_document jsonb;
  records_document jsonb := '[]'::jsonb;
  last_server_confirmed_at timestamptz;
  next_cursor text;
  page_size integer := 50;
  is_operational_reader boolean;
begin
  is_operational_reader := identity_document -> 'roles' ?| array['administrator', 'logistics'];
  if not is_operational_reader and not (identity_document -> 'roles' ? 'manager') then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;
  if not is_operational_reader and jsonb_array_length(identity_document -> 'scopeIds') = 0 then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;
  if p_from is null or p_to is null or p_from > p_to
     or p_status is distinct from 'pending'
     or (p_period is not null and p_period not in ('morning', 'afternoon')) then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  if p_seller_id is not null and not is_operational_reader and not exists (
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
      cursor_desired_date := split_part(cursor_payload, '|', 1)::date;
      cursor_period := split_part(cursor_payload, '|', 2);
      cursor_requested_at := split_part(cursor_payload, '|', 3)::timestamptz;
      cursor_schedule_id := split_part(cursor_payload, '|', 4)::uuid;
      if cursor_period not in ('morning', 'afternoon') or split_part(cursor_payload, '|', 5) <> '' then
        raise invalid_text_representation;
      end if;
    exception when others then
      raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
    end;
  end if;

  filters_document := jsonb_strip_nulls(jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'status', p_status,
    'period', p_period,
    'sellerId', p_seller_id,
    'clientId', p_client_id
  ));

  with filtered as materialized (
    select schedule.*
    from api.pickup_schedules schedule
    where schedule.status = 'pending'
      and schedule.desired_date between p_from and p_to
      and (p_period is null or schedule.period = p_period)
      and (p_seller_id is null or schedule.seller_id = p_seller_id)
      and (p_client_id is null or schedule.client_id = p_client_id)
      and (is_operational_reader or exists (
        select 1 from jsonb_array_elements_text(identity_document -> 'scopeIds') scope(id)
        where scope.id::uuid = schedule.seller_id
      ))
  ), page as (
    select *
    from filtered
    where p_cursor is null or (
      desired_date,
      case period when 'morning' then 1 else 2 end,
      requested_at,
      id
    ) > (
      cursor_desired_date,
      case cursor_period when 'morning' then 1 else 2 end,
      cursor_requested_at,
      cursor_schedule_id
    )
    order by desired_date,
      case period when 'morning' then 1 else 2 end,
      requested_at,
      id
    limit page_size + 1
  )
  select
    jsonb_build_object(
      'records', count(*)::integer,
      'scheduledKg', coalesce(sum(estimated_weight_kg), 0)::text
    ),
    max(updated_at),
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', row.id,
        'offlineId', row.offline_id,
        'client', jsonb_build_object(
          'id', row.client_id,
          'name', row.client_name_snapshot,
          'address', row.address_snapshot
        ),
        'seller', jsonb_build_object('id', row.seller_id, 'displayName', row.seller_name_snapshot),
        'origin', row.origin,
        'visitId', row.visit_id,
        'estimatedWeightKg', row.estimated_weight_kg::text,
        'desiredDate', row.desired_date,
        'period', row.period,
        'observation', row.observation,
        'requestedAt', row.requested_at,
        'serverSavedAt', row.created_at,
        'status', row.status,
        'version', row.version
      ) order by row.desired_date,
        case row.period when 'morning' then 1 else 2 end,
        row.requested_at,
        row.id)
      from (select * from page limit page_size) row
    ), '[]'::jsonb),
    case when (select count(*) from page) > page_size then (
      select private.scrap_agenda_cursor(row.desired_date, row.period, row.requested_at, row.id)
      from (select * from page limit page_size) row
      order by row.desired_date desc,
        case row.period when 'morning' then 1 else 2 end desc,
        row.requested_at desc,
        row.id desc
      limit 1
    ) end
  into indicators_document, last_server_confirmed_at, records_document, next_cursor
  from filtered;

  return jsonb_build_object(
    'schemaVersion', 1,
    'filters', filters_document,
    'generatedAt', generated_at,
    'lastServerConfirmedAt', last_server_confirmed_at,
    'indicators', indicators_document,
    'records', records_document,
    'nextCursor', next_cursor,
    'serverVisibilityNote',
      'Somente agendamentos recebidos e confirmados pelo servidor estão incluídos; conteúdo ainda apenas no aparelho não é conhecido.'
  );
end
$function$;

alter function api.get_scrap_agenda(date, date, text, text, uuid, uuid, text)
  owner to cirne_scrap_executor;

revoke all on function api.get_scrap_agenda(date, date, text, text, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function api.get_scrap_agenda(date, date, text, text, uuid, uuid, text)
  to authenticated;

revoke create on schema api, private from cirne_scrap_executor;
do $ownership$
begin
  execute pg_catalog.format('revoke cirne_scrap_executor from %I granted by current_user', current_user);
end
$ownership$;
notify pgrst, 'reload schema';
commit;
