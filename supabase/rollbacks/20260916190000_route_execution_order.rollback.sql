begin;

do $ownership$
begin
  execute pg_catalog.format('grant cirne_route_executor to %I with set true granted by current_user', current_user);
end
$ownership$;
grant create on schema api, private to cirne_route_executor;
set local role cirne_route_executor;

drop function if exists api.reorder_route_execution(uuid, jsonb, uuid, text);
drop function if exists private.reorder_route_execution(uuid, jsonb, uuid, text);

create or replace function private.build_route_document(p_route_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select jsonb_build_object(
    'schemaVersion', 1,
    'routeId', route_row.id,
    'routeVersionId', version_row.id,
    'versionNumber', version_row.version_number,
    'serviceDate', route_row.service_date,
    'status', 'published',
    'publishedAt', version_row.published_at,
    'seller', version_row.seller_context_snapshot,
    'stops', jsonb_agg(jsonb_build_object(
      'routeVersionStopId', stop_row.id,
      'plannedOrder', stop_row.planned_order,
      'executionOrder', execution_row.execution_order,
      'priority', stop_row.priority,
      'status', execution_row.status,
      'executionVersion', execution_row.lock_version,
      'client', stop_row.client_context_snapshot
    ) order by stop_row.planned_order)
  )
  from api.routes route_row
  join api.route_versions version_row on version_row.route_id = route_row.id
    and version_row.status = 'published' and version_row.superseded_at is null
  join api.route_version_stops stop_row on stop_row.route_version_id = version_row.id
  join api.route_stop_executions execution_row on execution_row.route_version_stop_id = stop_row.id
  where route_row.id = p_route_id
  group by route_row.id, version_row.id;
$function$;

create or replace function private.get_my_route_for_date(p_service_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  identity_document jsonb := private.route_identity('route.read_self');
  actor_id uuid := (identity_document ->> 'id')::uuid;
  route_id uuid;
begin
  if p_service_date is null then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  select route_row.id into route_id
  from api.routes route_row
  where route_row.seller_id = actor_id
    and route_row.service_date = p_service_date
    and route_row.status = 'published';

  if route_id is null then
    return jsonb_build_object(
      'schemaVersion', 1,
      'availability', 'empty',
      'serviceDate', p_service_date
    );
  end if;
  return jsonb_build_object(
    'schemaVersion', 1,
    'availability', 'available',
    'route', private.build_route_document(route_id)
  );
end
$function$;

alter table api.route_stop_executions
  drop constraint route_stop_executions_order_key;
alter table api.route_stop_executions
  add constraint route_stop_executions_order_key
  unique (route_version_id, execution_order);

reset role;

delete from api.role_permissions
where permission_code in ('route.reorder_self', 'route.reorder_scoped');

revoke create on schema api, private from cirne_route_executor;
do $ownership$
begin
  execute pg_catalog.format('revoke cirne_route_executor from %I granted by current_user', current_user);
end
$ownership$;

commit;
