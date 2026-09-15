begin;

do $preflight$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'cirne_sync_executor') then
    raise exception 'Sync foundation expects cirne_sync_executor role to be absent';
  end if;
  if to_regclass('private.sync_events') is not null or to_regclass('private.audit_events') is not null then
    raise exception 'Sync foundation expects sync/audit tables to be absent';
  end if;
end
$preflight$;

create role cirne_sync_executor
  nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;

insert into api.role_permissions (role_id, permission_code)
values ('00000000-0000-4000-8000-000000000001', 'sync.write_self')
on conflict (role_id, permission_code) do nothing;

create table private.sync_events (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references api.user_profiles(id) on delete restrict,
  device_id uuid not null,
  event_id uuid not null,
  idempotency_key uuid not null,
  operation text not null check (operation = 'visit.draft.saved'),
  schema_version integer not null check (schema_version = 1),
  sequence integer not null check (sequence > 0),
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  aggregate_type text not null check (aggregate_type = 'visit_draft'),
  aggregate_id uuid not null,
  status text not null check (status = 'confirmed'),
  attempt_count integer not null default 1 check (attempt_count > 0),
  canonical_result jsonb not null,
  occurred_at timestamptz not null,
  confirmed_at timestamptz not null,
  updated_at timestamptz not null default now(),
  constraint sync_events_idempotency_key unique
    (actor_id, device_id, operation, idempotency_key),
  constraint sync_events_event_id_key unique
    (actor_id, device_id, event_id)
);

create table private.audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references api.user_profiles(id) on delete restrict,
  target_type text not null,
  target_id uuid not null,
  action text not null,
  before_data jsonb,
  after_data jsonb,
  reason text,
  origin text not null check (origin in ('web', 'pwa', 'cli', 'system')),
  request_id uuid,
  occurred_at timestamptz not null default now()
);

create index sync_events_actor_device_status_updated_idx
  on private.sync_events (actor_id, device_id, status, updated_at);
create index audit_events_target_occurred_idx
  on private.audit_events (target_type, target_id, occurred_at desc);

revoke all on table private.sync_events from public, anon, authenticated;
revoke all on table private.audit_events from public, anon, authenticated;
grant usage, create on schema api, private to cirne_sync_executor;
grant usage on schema extensions to cirne_sync_executor;
grant select, insert on table private.sync_events to cirne_sync_executor;
grant insert on table private.audit_events to cirne_sync_executor;

do $identity_ownership$
begin
  execute pg_catalog.format('grant cirne_identity_executor to %I with set true granted by current_user', current_user);
end
$identity_ownership$;
set local role cirne_identity_executor;
grant execute on function private.resolve_current_identity() to cirne_sync_executor;
reset role;
do $identity_ownership$
begin
  execute pg_catalog.format('revoke cirne_identity_executor from %I granted by current_user', current_user);
end
$identity_ownership$;

create function private.sync_event(p_device_id uuid, p_command jsonb)
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

create function api.sync_event(p_device_id uuid, p_command jsonb)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $function$
  select private.sync_event(p_device_id, p_command);
$function$;

comment on function api.sync_event(uuid, jsonb) is
  'Confirma um evento sintético individual com idempotência e ordem por agregado.';

do $ownership$
begin
  execute pg_catalog.format('grant cirne_sync_executor to %I with set true granted by current_user', current_user);
end
$ownership$;
alter table private.sync_events owner to cirne_sync_executor;
alter table private.audit_events owner to cirne_sync_executor;
alter function private.sync_event(uuid, jsonb) owner to cirne_sync_executor;
alter function api.sync_event(uuid, jsonb) owner to cirne_sync_executor;
revoke create on schema api, private from cirne_sync_executor;
set local role cirne_sync_executor;
revoke all on function private.sync_event(uuid, jsonb) from public, anon, authenticated;
revoke all on function api.sync_event(uuid, jsonb) from public, anon;
grant execute on function api.sync_event(uuid, jsonb) to authenticated;
reset role;
do $ownership$
begin
  execute pg_catalog.format('revoke cirne_sync_executor from %I granted by current_user', current_user);
end
$ownership$;

commit;
