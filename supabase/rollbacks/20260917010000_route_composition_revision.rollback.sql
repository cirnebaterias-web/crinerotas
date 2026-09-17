begin;

do $ownership$
begin
  execute pg_catalog.format('grant cirne_route_executor to %I with set true granted by current_user', current_user);
end
$ownership$;
grant create on schema api, private to cirne_route_executor;
set local role cirne_route_executor;

drop function if exists api.change_route_composition(uuid,jsonb,uuid,text);
drop function if exists private.change_route_composition(uuid,jsonb,uuid,text);

create or replace function private.build_route_document(p_route_id uuid)
returns jsonb language sql stable security definer set search_path = ''
as $function$
  select jsonb_build_object(
    'schemaVersion', 2,
    'routeId', route_row.id,
    'routeVersionId', version_row.id,
    'versionNumber', version_row.version_number,
    'serviceDate', route_row.service_date,
    'status', 'published',
    'publishedAt', version_row.published_at,
    'executionVersion', route_row.lock_version,
    'seller', version_row.seller_context_snapshot,
    'stops', jsonb_agg(jsonb_build_object(
      'routeVersionStopId', stop_row.id,
      'plannedOrder', stop_row.planned_order,
      'executionOrder', execution_row.execution_order,
      'priority', stop_row.priority,
      'status', execution_row.status,
      'executionVersion', execution_row.lock_version,
      'client', stop_row.client_context_snapshot
    ) order by execution_row.execution_order, stop_row.id)
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
returns jsonb language plpgsql stable security definer set search_path = ''
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
    return jsonb_build_object('schemaVersion', 2, 'availability', 'empty', 'serviceDate', p_service_date);
  end if;
  return jsonb_build_object('schemaVersion', 2, 'availability', 'available',
    'route', private.build_route_document(route_id));
end
$function$;

reset role;
do $audit_ownership$
begin
  execute pg_catalog.format('grant cirne_sync_executor to %I with set true granted by current_user', current_user);
end
$audit_ownership$;
grant create on schema private to cirne_sync_executor;
set local role cirne_sync_executor;
drop index if exists private.audit_events_route_composition_idempotency_key;
revoke select on table private.audit_events from cirne_route_executor;
reset role;
revoke create on schema private from cirne_sync_executor;
do $audit_ownership$
begin
  execute pg_catalog.format('revoke cirne_sync_executor from %I granted by current_user', current_user);
end
$audit_ownership$;

revoke create on schema api, private from cirne_route_executor;
do $ownership$
begin
  execute pg_catalog.format('revoke cirne_route_executor from %I granted by current_user', current_user);
end
$ownership$;

-- change_reason/change_summary and already-published versions remain intentionally preserved.
commit;
