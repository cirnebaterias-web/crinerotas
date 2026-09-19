-- Empty-capability rollback only. Stop application writers before running this script.
-- Once visits exist, preserve this schema and use a separately reviewed recovery plan.
-- Never delete visit history or idempotency records just to bypass the preflight.
begin;
set local lock_timeout = '5s';

do $preflight$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'cirne_visit_executor')
     or to_regclass('api.visits') is null
     or to_regprocedure('api.start_visit(uuid,uuid,jsonb)') is null then
    raise exception 'Visit start rollback expects the capability to be installed';
  end if;
  -- Hold this through COMMIT: a concurrent start cannot insert after the emptiness check.
  -- The local postgres operator bypasses RLS but is not a superuser; acquire locks
  -- as each table owner, following the same temporary membership used below.
  execute pg_catalog.format('grant cirne_visit_executor to %I with set true granted by current_user', current_user);
  set local role cirne_visit_executor;
  lock table api.visits in access exclusive mode;
  reset role;
  execute pg_catalog.format('revoke cirne_visit_executor from %I granted by current_user', current_user);
  execute pg_catalog.format('grant cirne_sync_executor to %I with set true granted by current_user', current_user);
  set local role cirne_sync_executor;
  lock table private.sync_events in access exclusive mode;
  reset role;
  execute pg_catalog.format('revoke cirne_sync_executor from %I granted by current_user', current_user);
  if exists (select 1 from api.visits)
     or exists (select 1 from private.sync_events where operation = 'visit.started.v1') then
    raise exception using errcode = 'P0001',
      message = 'VISIT_ROLLBACK_REQUIRES_COORDINATED_RECOVERY',
      hint = 'Keep visit history and confirmations intact; use a reviewed recovery plan instead of this empty-capability rollback.';
  end if;
end
$preflight$;

do $sync_ownership$
begin
  execute pg_catalog.format('grant cirne_sync_executor to %I with set true granted by current_user', current_user);
end
$sync_ownership$;
-- The migration runner owns schema private. Grant before SET ROLE because
-- cirne_sync_executor cannot grant CREATE to itself.
grant create on schema private to cirne_sync_executor;
set local role cirne_sync_executor;
create or replace function private.sync_event(p_device_id uuid, p_command jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  identity_document jsonb;
  v_actor_id uuid;
  v_event_id uuid;
  v_idempotency_key uuid;
  v_operation text;
  v_schema_version integer;
  v_event_sequence integer;
  v_aggregate_type text;
  v_aggregate_id uuid;
  v_occurred_at timestamptz;
  v_payload jsonb;
  v_payload_hash text;
  previous_event private.sync_events%rowtype;
  previous_sequence integer;
  confirmation_time timestamptz;
  canonical_result jsonb;
begin
  identity_document := private.resolve_current_identity();
  if identity_document is null or not (identity_document -> 'capabilities' @> '["sync.write_self"]'::jsonb) then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;
  v_actor_id := (identity_document ->> 'id')::uuid;

  if p_device_id is null
     or jsonb_typeof(p_command) <> 'object'
     or (select count(*) from pg_catalog.jsonb_object_keys(p_command)) <> 9
     or not (p_command ?& array[
       'eventId', 'idempotencyKey', 'operation', 'schemaVersion', 'sequence',
       'aggregateType', 'aggregateId', 'occurredAt', 'payload'
     ]) then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;

  begin
    v_event_id := (p_command ->> 'eventId')::uuid;
    v_idempotency_key := (p_command ->> 'idempotencyKey')::uuid;
    v_operation := p_command ->> 'operation';
    v_schema_version := (p_command ->> 'schemaVersion')::integer;
    v_event_sequence := (p_command ->> 'sequence')::integer;
    v_aggregate_type := p_command ->> 'aggregateType';
    v_aggregate_id := (p_command ->> 'aggregateId')::uuid;
    v_occurred_at := (p_command ->> 'occurredAt')::timestamptz;
    v_payload := p_command -> 'payload';
  exception when invalid_text_representation or numeric_value_out_of_range
    or invalid_datetime_format or datetime_field_overflow then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end;

  if v_event_id is null
     or v_idempotency_key is null
     or v_operation is distinct from 'visit.draft.saved'
     or v_schema_version is distinct from 1
     or v_event_sequence is null
     or v_event_sequence < 1
     or v_aggregate_type is distinct from 'visit_draft'
     or v_aggregate_id is null
     or v_occurred_at is null
     or jsonb_typeof(v_payload) <> 'object'
     or (select count(*) from pg_catalog.jsonb_object_keys(v_payload)) <> 3
     or not (v_payload ?& array['draftOfflineId', 'routeVersionStopId', 'acknowledged'])
     or (v_payload ->> 'draftOfflineId') is null
     or (v_payload ->> 'routeVersionStopId') is null
     or jsonb_typeof(v_payload -> 'acknowledged') <> 'boolean' then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;

  begin
    if (v_payload ->> 'draftOfflineId')::uuid <> v_aggregate_id then
      raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
    end if;
    perform (v_payload ->> 'routeVersionStopId')::uuid;
  exception when invalid_text_representation then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end;

  v_payload_hash := encode(extensions.digest(pg_catalog.convert_to((jsonb_build_object(
    'operation', v_operation,
    'schemaVersion', v_schema_version,
    'aggregateType', v_aggregate_type,
    'aggregateId', v_aggregate_id,
    'sequence', v_event_sequence,
    'occurredAt', to_char(
      v_occurred_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ),
    'payload', v_payload
  ))::text, 'UTF8'), 'sha256'), 'hex');

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    v_actor_id::text || ':' || p_device_id::text || ':' || v_operation || ':' || v_idempotency_key::text,
    0
  ));

  select * into previous_event
  from private.sync_events stored
  where stored.actor_id = v_actor_id
    and stored.device_id = p_device_id
    and stored.operation = v_operation
    and stored.idempotency_key = v_idempotency_key;

  if found then
    if previous_event.payload_hash <> v_payload_hash then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return previous_event.canonical_result;
  end if;

  if exists (
    select 1 from private.sync_events stored
    where stored.actor_id = v_actor_id
      and stored.device_id = p_device_id
      and stored.event_id = v_event_id
  ) then
    raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSED';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    v_actor_id::text || ':' || p_device_id::text || ':' || v_aggregate_type || ':' || v_aggregate_id::text,
    1
  ));
  select max(stored.sequence) into previous_sequence
  from private.sync_events stored
  where stored.actor_id = v_actor_id
    and stored.device_id = p_device_id
    and stored.aggregate_type = v_aggregate_type
    and stored.aggregate_id = v_aggregate_id;

  if v_event_sequence <> coalesce(previous_sequence + 1, 1) then
    raise exception using errcode = 'P0001', message = 'EVENT_OUT_OF_ORDER';
  end if;

  confirmation_time := clock_timestamp();
  canonical_result := jsonb_build_object(
    'eventId', v_event_id,
    'status', 'confirmed',
    'canonicalId', v_aggregate_id,
    'confirmedAt', to_char(confirmation_time at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );

  insert into private.sync_events (
    actor_id, device_id, event_id, idempotency_key, operation, schema_version,
    sequence, payload_hash, aggregate_type, aggregate_id, status, attempt_count,
    canonical_result, occurred_at, confirmed_at
  ) values (
    v_actor_id, p_device_id, v_event_id, v_idempotency_key, v_operation, v_schema_version,
    v_event_sequence, v_payload_hash, v_aggregate_type, v_aggregate_id, 'confirmed', 1,
    canonical_result, v_occurred_at, confirmation_time
  );

  insert into private.audit_events (
    actor_id, target_type, target_id, action, after_data, origin, occurred_at
  ) values (
    v_actor_id, v_aggregate_type, v_aggregate_id, v_operation, canonical_result, 'system', confirmation_time
  );

  return canonical_result;
end
$function$;

delete from private.sync_events where operation = 'visit.started.v1';
alter table private.sync_events drop constraint sync_events_operation_check;
alter table private.sync_events add constraint sync_events_operation_check
  check (operation = 'visit.draft.saved');
alter table private.sync_events drop constraint sync_events_aggregate_type_check;
alter table private.sync_events add constraint sync_events_aggregate_type_check
  check (aggregate_type = 'visit_draft');
revoke execute on function private.sync_event(uuid, jsonb) from cirne_visit_executor;
revoke insert on table private.audit_events from cirne_visit_executor;
-- Return to the schema owner before revoking the temporary CREATE privilege.
reset role;
revoke create on schema private from cirne_sync_executor;
do $sync_ownership$
begin
  execute pg_catalog.format('revoke cirne_sync_executor from %I granted by current_user', current_user);
end
$sync_ownership$;

do $visit_ownership$
begin
  execute pg_catalog.format('grant cirne_visit_executor to %I with set true granted by current_user', current_user);
end
$visit_ownership$;
set local role cirne_visit_executor;
drop function api.start_visit(uuid, uuid, jsonb);
drop function private.start_visit(uuid, uuid, jsonb);
drop function private.apply_visit_started(uuid, jsonb);
drop function private.get_visit_start_result(uuid);
drop function private.visit_identity();

drop table api.location_events;
drop table api.visits;
drop table api.parameter_sets;
reset role;
do $visit_ownership$
begin
  execute pg_catalog.format('revoke cirne_visit_executor from %I granted by current_user', current_user);
end
$visit_ownership$;

do $route_ownership$
begin
  execute pg_catalog.format('grant cirne_route_executor to %I with set true granted by current_user', current_user);
end
$route_ownership$;
set local role cirne_route_executor;
drop policy routes_visit_executor_read on api.routes;
drop policy route_versions_visit_executor_read on api.route_versions;
drop policy route_version_stops_visit_executor_read on api.route_version_stops;
drop policy route_stop_executions_visit_executor_write on api.route_stop_executions;
revoke all on table api.routes, api.route_versions, api.route_version_stops,
  api.route_stop_executions from cirne_visit_executor;
alter table api.route_version_stops drop constraint route_version_stops_id_client_key;
reset role;
do $route_ownership$
begin
  execute pg_catalog.format('revoke cirne_route_executor from %I granted by current_user', current_user);
end
$route_ownership$;

drop policy user_profiles_visit_executor_read on api.user_profiles;

do $identity_ownership$
begin
  execute pg_catalog.format('grant cirne_identity_executor to %I with set true granted by current_user', current_user);
end
$identity_ownership$;
set local role cirne_identity_executor;
revoke execute on function private.resolve_current_identity() from cirne_visit_executor;
reset role;
do $identity_ownership$
begin
  execute pg_catalog.format('revoke cirne_identity_executor from %I granted by current_user', current_user);
end
$identity_ownership$;

delete from api.role_permissions
where role_id = '00000000-0000-4000-8000-000000000001'
  and permission_code = 'visit.start_self';

do $visit_drop_ownership$
begin
  execute pg_catalog.format('grant cirne_visit_executor to %I with set true granted by current_user', current_user);
end
$visit_drop_ownership$;
drop owned by cirne_visit_executor;
drop role cirne_visit_executor;

commit;
