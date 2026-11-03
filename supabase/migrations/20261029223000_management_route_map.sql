begin;

do $preflight$
begin
  if to_regprocedure('api.get_management_route_map(date)') is not null then
    raise exception 'Management route map function already exists';
  end if;
  if to_regprocedure('private.management_identity()') is null then
    raise exception 'Management route map requires the management identity foundation';
  end if;
end
$preflight$;

do $ownership$
begin
  execute pg_catalog.format('grant cirne_management_executor to %I with set true granted by current_user', current_user);
end
$ownership$;
grant create on schema api to cirne_management_executor;
set local role cirne_management_executor;

create function api.get_management_route_map(p_service_date date)
returns jsonb language plpgsql stable security definer set search_path = '' as $function$
declare
  identity_document jsonb := private.management_identity();
  generated_at timestamptz := statement_timestamp();
  routes_document jsonb;
  route_count integer;
  stop_count integer;
  positioned_count integer;
begin
  if p_service_date is null then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;

  with raw_stops as (
    select route_row.id as route_id, route_row.seller_id,
      version_row.id as route_version_id, version_row.version_number,
      coalesce(version_row.seller_context_snapshot ->> 'displayName', 'Vendedor sem nome') as seller_display_name,
      stop_row.id as route_version_stop_id, stop_row.client_id,
      coalesce(stop_row.client_context_snapshot ->> 'name', 'Cliente sem nome') as client_name,
      coalesce(stop_row.client_context_snapshot ->> 'address', 'Endereço não informado') as client_address,
      stop_row.client_context_snapshot ->> 'latitude' as raw_latitude,
      stop_row.client_context_snapshot ->> 'longitude' as raw_longitude,
      stop_row.planned_order, execution_row.execution_order, stop_row.priority, execution_row.status
    from api.routes route_row
    join api.route_versions version_row on version_row.route_id = route_row.id
      and version_row.status = 'published' and version_row.superseded_at is null
    join api.route_version_stops stop_row on stop_row.route_version_id = version_row.id
    join api.route_stop_executions execution_row on execution_row.route_version_stop_id = stop_row.id
    where route_row.service_date = p_service_date
      and route_row.status in ('published', 'in_progress', 'closed')
      and exists (
        select 1 from jsonb_array_elements_text(identity_document -> 'scopeIds') scope(id)
        where scope.id::uuid = route_row.seller_id
      )
  ), parsed_stops as (
    select raw.*,
      case when raw.raw_latitude ~ '^-?(0|[1-9][0-9]*)(\.[0-9]+)?$'
        then raw.raw_latitude::numeric end as latitude_value,
      case when raw.raw_longitude ~ '^-?(0|[1-9][0-9]*)(\.[0-9]+)?$'
        then raw.raw_longitude::numeric end as longitude_value
    from raw_stops raw
  ), normalized_stops as (
    select parsed.*,
      case when parsed.latitude_value between -90 and 90
          and parsed.longitude_value between -180 and 180
        then jsonb_build_object(
          'latitude', parsed.raw_latitude,
          'longitude', parsed.raw_longitude
        ) else null end as location_document
    from parsed_stops parsed
  ), route_documents as (
    select stop.route_id, stop.route_version_id, stop.version_number, stop.seller_id, stop.seller_display_name,
      jsonb_agg(jsonb_build_object(
        'routeVersionStopId', stop.route_version_stop_id,
        'plannedOrder', stop.planned_order,
        'executionOrder', stop.execution_order,
        'priority', stop.priority,
        'client', jsonb_build_object(
          'id', stop.client_id, 'name', stop.client_name, 'address', stop.client_address
        ),
        'status', stop.status,
        'location', stop.location_document
      ) order by stop.execution_order, stop.route_version_stop_id) as stops,
      count(*)::integer as stops_count,
      count(*) filter (where stop.location_document is not null)::integer as positioned_count
    from normalized_stops stop
    group by stop.route_id, stop.route_version_id, stop.version_number, stop.seller_id, stop.seller_display_name
  ), projection as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'routeId', route.route_id,
      'routeVersionId', route.route_version_id,
      'versionNumber', route.version_number,
      'seller', jsonb_build_object('id', route.seller_id, 'displayName', route.seller_display_name),
      'stops', route.stops
    ) order by route.seller_display_name, route.route_id), '[]'::jsonb) as routes,
      count(*)::integer as routes_count,
      coalesce(sum(route.stops_count), 0)::integer as stops_count,
      coalesce(sum(route.positioned_count), 0)::integer as positioned_count
    from route_documents route
  )
  select projection.routes, projection.routes_count, projection.stops_count, projection.positioned_count
    into routes_document, route_count, stop_count, positioned_count
  from projection;

  return jsonb_build_object(
    'schemaVersion', 1,
    'serviceDate', p_service_date,
    'generatedAt', generated_at,
    'availability', case when route_count = 0 then 'empty' else 'available' end,
    'totals', jsonb_build_object(
      'routes', route_count,
      'stops', stop_count,
      'positioned', positioned_count,
      'unpositioned', stop_count - positioned_count
    ),
    'routes', routes_document,
    'serverVisibilityNote',
      'O mapa usa coordenadas cadastrais do snapshot publicado; não exibe GPS observado nem representa trajeto por ruas.'
  );
end
$function$;

comment on function api.get_management_route_map(date) is
  'Projeta somente coordenadas cadastrais versionadas das paradas publicadas no escopo do Gestor.';

revoke all on function api.get_management_route_map(date) from public, anon;
grant execute on function api.get_management_route_map(date) to authenticated;

reset role;
revoke create on schema api from cirne_management_executor;
do $ownership$
begin
  execute pg_catalog.format('revoke cirne_management_executor from %I granted by current_user', current_user);
end
$ownership$;

commit;
