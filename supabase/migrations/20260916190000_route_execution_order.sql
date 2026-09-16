begin;

do $preflight$
begin
  if to_regclass('api.route_stop_executions') is null then
    raise exception 'Route execution order requires the route foundation';
  end if;
  if exists (
    select 1
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'api' and procedure.proname = 'reorder_route_execution'
  ) then
    raise exception 'Route execution order function already exists';
  end if;
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'api.route_stop_executions'::regclass
      and conname = 'route_stop_executions_order_key'
      and contype = 'u'
      and not condeferrable
  ) then
    raise exception 'Expected the original immediate route execution order constraint';
  end if;
end
$preflight$;

insert into api.role_permissions (role_id, permission_code)
values
  ('00000000-0000-4000-8000-000000000001', 'route.reorder_self'),
  ('00000000-0000-4000-8000-000000000002', 'route.reorder_scoped')
on conflict (role_id, permission_code) do nothing;

do $ownership$
begin
  execute pg_catalog.format('grant cirne_route_executor to %I with set true granted by current_user', current_user);
end
$ownership$;
grant create on schema api, private to cirne_route_executor;
set local role cirne_route_executor;

alter table api.route_stop_executions
  drop constraint route_stop_executions_order_key;
alter table api.route_stop_executions
  add constraint route_stop_executions_order_key
  unique (route_version_id, execution_order)
  deferrable initially immediate;

create function private.reorder_route_execution(
  p_route_id uuid,
  p_command jsonb,
  p_request_id uuid,
  p_origin text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  identity_document jsonb := private.resolve_current_identity();
  actor_id uuid;
  route_row api.routes%rowtype;
  v_route_version_id uuid;
  expected_version integer;
  requested_ids uuid[];
  current_ids uuid[];
  available_positions integer[];
  pending_count integer;
  result_version integer;
  can_reorder_self boolean := false;
  can_reorder_scoped boolean := false;
  before_document jsonb;
  after_document jsonb;
begin
  if identity_document is null then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;
  actor_id := (identity_document ->> 'id')::uuid;

  if p_route_id is null or p_request_id is null or p_origin is null or p_origin not in ('web', 'pwa', 'cli')
     or p_command is null or jsonb_typeof(p_command) <> 'object'
     or not (p_command ?& array['schemaVersion', 'expectedVersion', 'pendingStopIds'])
     or (select count(*) from jsonb_object_keys(p_command)) <> 3
     or p_command -> 'schemaVersion' <> '1'::jsonb
     or jsonb_typeof(p_command -> 'expectedVersion') <> 'number'
     or jsonb_typeof(p_command -> 'pendingStopIds') <> 'array' then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;

  begin
    expected_version := (p_command ->> 'expectedVersion')::integer;
    select array_agg(stop_id order by position), count(*)::integer
    into requested_ids, pending_count
    from (
      select value::uuid as stop_id, ordinality as position
      from jsonb_array_elements_text(p_command -> 'pendingStopIds') with ordinality
    ) requested;
  exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end;

  if expected_version < 1 or pending_count < 1 or pending_count > 50
     or (select count(distinct stop_id) from unnest(requested_ids) stop_id) <> pending_count then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;

  can_reorder_self := identity_document -> 'capabilities' @> '["route.reorder_self"]'::jsonb;
  can_reorder_scoped := identity_document -> 'capabilities' @> '["route.reorder_scoped"]'::jsonb;
  if not can_reorder_self and not can_reorder_scoped then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;

  select * into route_row
  from api.routes
  where id = p_route_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'NOT_FOUND';
  end if;

  can_reorder_self := can_reorder_self and actor_id = route_row.seller_id;
  can_reorder_scoped := can_reorder_scoped
    and exists (
      select 1
      from jsonb_array_elements_text(identity_document -> 'scopeIds') scope_id
      where scope_id::uuid = route_row.seller_id
    );
  if not can_reorder_self and not can_reorder_scoped then
    raise exception using errcode = 'P0001', message = 'NOT_FOUND';
  end if;

  if route_row.status <> 'published' then
    raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT';
  end if;
  if route_row.lock_version <> expected_version then
    raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT';
  end if;

  select version_row.id into v_route_version_id
  from api.route_versions version_row
  where version_row.route_id = p_route_id
    and version_row.status = 'published'
    and version_row.superseded_at is null
  for update;
  if v_route_version_id is null then
    raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT';
  end if;

  perform execution_row.id
  from api.route_stop_executions execution_row
  where execution_row.route_version_id = v_route_version_id
  order by execution_row.id
  for update;

  select
    array_agg(execution_row.route_version_stop_id order by execution_row.execution_order, execution_row.id),
    array_agg(execution_row.execution_order order by execution_row.execution_order, execution_row.id),
    count(*)::integer
  into current_ids, available_positions, pending_count
  from api.route_stop_executions execution_row
  where execution_row.route_version_id = v_route_version_id
    and execution_row.status = 'pending';

  if pending_count < 1 or cardinality(requested_ids) <> pending_count
     or exists (
       select 1 from unnest(requested_ids) requested_id
       where not requested_id = any(current_ids)
     ) then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;

  if requested_ids = current_ids then
    return jsonb_build_object(
      'schemaVersion', 1,
      'routeId', p_route_id,
      'routeVersionId', v_route_version_id,
      'executionVersion', route_row.lock_version,
      'changed', false,
      'pendingStopIds', to_jsonb(requested_ids)
    );
  end if;

  before_document := jsonb_build_object(
    'routeVersionId', v_route_version_id,
    'executionVersion', route_row.lock_version,
    'pendingStopIds', to_jsonb(current_ids)
  );

  set constraints api.route_stop_executions_order_key deferred;
  with requested as (
    select stop_id, ordinality as position
    from unnest(requested_ids) with ordinality requested(stop_id, ordinality)
  ), positions as (
    select execution_order, ordinality as position
    from unnest(available_positions) with ordinality positions(execution_order, ordinality)
  )
  update api.route_stop_executions execution_row
  set execution_order = positions.execution_order
  from requested
  join positions using (position)
  where execution_row.route_version_id = v_route_version_id
    and execution_row.status = 'pending'
    and execution_row.route_version_stop_id = requested.stop_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;

  set constraints api.route_stop_executions_order_key immediate;

  update api.routes
  set lock_version = lock_version + 1
  where id = p_route_id
    and lock_version = expected_version
    and status = 'published'
  returning lock_version into result_version;
  if not found then
    raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT';
  end if;

  after_document := jsonb_build_object(
    'routeVersionId', v_route_version_id,
    'executionVersion', result_version,
    'pendingStopIds', to_jsonb(requested_ids)
  );
  insert into private.audit_events (
    actor_id, target_type, target_id, action, before_data, after_data, origin, request_id
  ) values (
    actor_id, 'route', p_route_id, 'route.execution_order.changed',
    before_document, after_document, p_origin, p_request_id
  );

  return jsonb_build_object(
    'schemaVersion', 1,
    'routeId', p_route_id,
    'routeVersionId', v_route_version_id,
    'executionVersion', result_version,
    'changed', true,
    'pendingStopIds', to_jsonb(requested_ids)
  );
end
$function$;

create or replace function private.build_route_document(p_route_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
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
      'schemaVersion', 2,
      'availability', 'empty',
      'serviceDate', p_service_date
    );
  end if;
  return jsonb_build_object(
    'schemaVersion', 2,
    'availability', 'available',
    'route', private.build_route_document(route_id)
  );
end
$function$;

create function api.reorder_route_execution(
  p_route_id uuid,
  p_command jsonb,
  p_request_id uuid,
  p_origin text
)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $function$
  select private.reorder_route_execution(p_route_id, p_command, p_request_id, p_origin);
$function$;

comment on function api.reorder_route_execution(uuid, jsonb, uuid, text)
  is 'Reordena atomicamente todas as paradas pendentes sem alterar a composição publicada.';

alter function private.reorder_route_execution(uuid, jsonb, uuid, text) owner to cirne_route_executor;
alter function api.reorder_route_execution(uuid, jsonb, uuid, text) owner to cirne_route_executor;

revoke all on function private.reorder_route_execution(uuid, jsonb, uuid, text)
  from public, anon, authenticated;
revoke all on function api.reorder_route_execution(uuid, jsonb, uuid, text)
  from public, anon;
grant execute on function api.reorder_route_execution(uuid, jsonb, uuid, text)
  to authenticated;
reset role;
revoke create on schema api, private from cirne_route_executor;

do $ownership$
begin
  execute pg_catalog.format('revoke cirne_route_executor from %I granted by current_user', current_user);
end
$ownership$;

commit;
