begin;

do $preflight$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'cirne_visit_executor') then
    raise exception 'Visit start expects cirne_visit_executor role to be absent';
  end if;
  if to_regclass('api.visits') is not null or to_regclass('api.location_events') is not null
     or to_regclass('api.parameter_sets') is not null then
    raise exception 'Visit start expects visit and parameter tables to be absent';
  end if;
end
$preflight$;

create role cirne_visit_executor
  nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;

insert into api.role_permissions (role_id, permission_code)
values ('00000000-0000-4000-8000-000000000001', 'visit.start_self')
on conflict (role_id, permission_code) do nothing;

create table api.parameter_sets (
  id uuid primary key default gen_random_uuid(),
  version integer not null unique check (version > 0),
  status text not null check (status in ('draft', 'published', 'retired')),
  valid_from timestamptz not null,
  published_at timestamptz,
  published_by uuid references api.user_profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint parameter_sets_publication_check check (
    (status = 'draft' and published_at is null and published_by is null)
    or (status in ('published', 'retired') and published_at is not null and published_by is not null)
  )
);

create unique index parameter_sets_current_published_key
  on api.parameter_sets ((status)) where status = 'published';

do $route_ownership$
begin
  execute pg_catalog.format('grant cirne_route_executor to %I with set true granted by current_user', current_user);
end
$route_ownership$;
grant create on schema api to cirne_route_executor;
set local role cirne_route_executor;
alter table api.route_version_stops
  add constraint route_version_stops_id_client_key unique (id, client_id);
do $reference_grant$
begin
  execute pg_catalog.format(
    'grant references on table api.route_version_stops to %I',
    session_user
  );
end
$reference_grant$;
reset role;
revoke create on schema api from cirne_route_executor;
do $route_ownership$
begin
  execute pg_catalog.format('revoke cirne_route_executor from %I granted by current_user', current_user);
end
$route_ownership$;

create table api.visits (
  id uuid primary key default gen_random_uuid(),
  offline_id uuid not null,
  device_id uuid not null,
  route_version_stop_id uuid not null,
  route_version_id uuid not null,
  client_id uuid not null,
  seller_id uuid not null references api.user_profiles(id) on delete restrict,
  parameter_set_id uuid not null references api.parameter_sets(id) on delete restrict,
  status text not null check (status = 'in_progress'),
  context_schema_version integer not null default 1 check (context_schema_version = 1),
  context_snapshot jsonb not null,
  start_payload_hash text not null check (start_payload_hash ~ '^[0-9a-f]{64}$'),
  device_started_at timestamptz not null,
  server_started_at timestamptz not null,
  lock_version integer not null default 1 check (lock_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint visits_offline_identity_key unique (seller_id, device_id, offline_id),
  constraint visits_id_parameter_set_key unique (id, parameter_set_id),
  constraint visits_stop_version_fkey foreign key (route_version_stop_id, route_version_id)
    references api.route_version_stops(id, route_version_id) on delete restrict,
  constraint visits_stop_client_fkey foreign key (route_version_stop_id, client_id)
    references api.route_version_stops(id, client_id) on delete restrict
);

do $route_ownership$
begin
  execute pg_catalog.format('grant cirne_route_executor to %I with set true granted by current_user', current_user);
end
$route_ownership$;
set local role cirne_route_executor;
do $reference_revoke$
begin
  execute pg_catalog.format(
    'revoke references on table api.route_version_stops from %I',
    session_user
  );
end
$reference_revoke$;
reset role;
do $route_ownership$
begin
  execute pg_catalog.format('revoke cirne_route_executor from %I granted by current_user', current_user);
end
$route_ownership$;

create table api.location_events (
  id uuid primary key default gen_random_uuid(),
  visit_id uuid not null references api.visits(id) on delete restrict,
  kind text not null check (kind = 'start'),
  device_captured_at timestamptz not null,
  server_received_at timestamptz not null,
  position extensions.geography(point, 4326) not null,
  accuracy_m numeric,
  distance_m numeric,
  exception_reason text,
  created_at timestamptz not null default now(),
  constraint location_events_start_key unique (visit_id, kind),
  constraint location_events_measurements_check check (
    (accuracy_m is null or accuracy_m >= 0)
    and (distance_m is null or distance_m >= 0)
    and exception_reason is null
  )
);

create index visits_stop_started_idx on api.visits (route_version_stop_id, server_started_at desc);
create index visits_seller_started_idx on api.visits (seller_id, server_started_at desc);
create index location_events_position_idx on api.location_events using gist (position);

create trigger visits_set_updated_at
before update on api.visits
for each row execute function private.set_updated_at();

alter table api.parameter_sets enable row level security;
alter table api.parameter_sets force row level security;
alter table api.visits enable row level security;
alter table api.visits force row level security;
alter table api.location_events enable row level security;
alter table api.location_events force row level security;

create policy parameter_sets_visit_executor_all on api.parameter_sets
  for all to cirne_visit_executor using (true) with check (true);
create policy visits_visit_executor_all on api.visits
  for all to cirne_visit_executor using (true) with check (true);
create policy location_events_visit_executor_all on api.location_events
  for all to cirne_visit_executor using (true) with check (true);
revoke all on table api.parameter_sets, api.visits, api.location_events
  from public, anon, authenticated;
grant usage, create on schema api, private to cirne_visit_executor;
grant usage on schema extensions to cirne_visit_executor;
grant select on table api.parameter_sets to cirne_visit_executor;
grant select, insert on table api.visits, api.location_events to cirne_visit_executor;
grant select, insert, update on table api.parameter_sets to service_role;

do $route_ownership$
begin
  execute pg_catalog.format('grant cirne_route_executor to %I with set true granted by current_user', current_user);
end
$route_ownership$;
set local role cirne_route_executor;
create policy routes_visit_executor_read on api.routes
  for select to cirne_visit_executor using (true);
create policy route_versions_visit_executor_read on api.route_versions
  for select to cirne_visit_executor using (true);
create policy route_version_stops_visit_executor_read on api.route_version_stops
  for select to cirne_visit_executor using (true);
create policy route_stop_executions_visit_executor_write on api.route_stop_executions
  for all to cirne_visit_executor using (true) with check (true);
grant select on table api.routes, api.route_versions, api.route_version_stops to cirne_visit_executor;
grant select, update on table api.route_stop_executions to cirne_visit_executor;
reset role;
do $route_ownership$
begin
  execute pg_catalog.format('revoke cirne_route_executor from %I granted by current_user', current_user);
end
$route_ownership$;

do $identity_ownership$
begin
  execute pg_catalog.format('grant cirne_identity_executor to %I with set true granted by current_user', current_user);
end
$identity_ownership$;
create policy user_profiles_visit_executor_read on api.user_profiles
  for select to cirne_visit_executor using (true);
grant select on table api.user_profiles to cirne_visit_executor;
set local role cirne_identity_executor;
grant execute on function private.resolve_current_identity() to cirne_visit_executor;
reset role;
do $identity_ownership$
begin
  execute pg_catalog.format('revoke cirne_identity_executor from %I granted by current_user', current_user);
end
$identity_ownership$;

do $sync_ownership$
begin
  execute pg_catalog.format('grant cirne_sync_executor to %I with set true granted by current_user', current_user);
end
$sync_ownership$;
set local role cirne_sync_executor;
grant insert on table private.audit_events to cirne_visit_executor;
reset role;
do $sync_ownership$
begin
  execute pg_catalog.format('revoke cirne_sync_executor from %I granted by current_user', current_user);
end
$sync_ownership$;

create function private.visit_identity()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  identity_document jsonb := private.resolve_current_identity();
begin
  if identity_document is null
     or not (identity_document -> 'capabilities' @> '["visit.start_self"]'::jsonb)
     or not (identity_document -> 'roles' @> '["seller"]'::jsonb) then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;
  return identity_document;
end
$function$;

create function private.get_visit_start_result(p_visit_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  identity_document jsonb := private.visit_identity();
  actor_id uuid := (identity_document ->> 'id')::uuid;
  result_document jsonb;
begin
  select jsonb_build_object(
    'schemaVersion', 1,
    'visitId', visit_row.id,
    'offlineId', visit_row.offline_id,
    'deviceId', visit_row.device_id,
    'routeVersionStopId', visit_row.route_version_stop_id,
    'routeVersionId', visit_row.route_version_id,
    'clientId', visit_row.client_id,
    'sellerId', visit_row.seller_id,
    'parameterSetId', visit_row.parameter_set_id,
    'status', visit_row.status,
    'contextSnapshot', visit_row.context_snapshot,
    'deviceStartedAt', visit_row.device_started_at,
    'serverStartedAt', visit_row.server_started_at
  ) into result_document
  from api.visits visit_row
  where visit_row.id = p_visit_id and visit_row.seller_id = actor_id;

  if result_document is null then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;
  return result_document;
end
$function$;

create function private.apply_visit_started(p_device_id uuid, p_command jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  identity_document jsonb := private.visit_identity();
  actor_id uuid := (identity_document ->> 'id')::uuid;
  payload jsonb := p_command -> 'payload';
  v_offline_id uuid;
  v_stop_id uuid;
  v_device_started_at timestamptz;
  v_payload_hash text;
  v_visit_id uuid := gen_random_uuid();
  v_server_started_at timestamptz := clock_timestamp();
  v_parameter_set api.parameter_sets%rowtype;
  stop_context record;
  existing_visit api.visits%rowtype;
  context_document jsonb;
  location_document jsonb;
  v_latitude numeric;
  v_longitude numeric;
  v_accuracy numeric;
  v_distance numeric;
begin
  if p_device_id is null or jsonb_typeof(payload) <> 'object'
     or not (payload ?& array['offlineId', 'routeVersionStopId', 'deviceStartedAt'])
     or exists (
       select 1 from jsonb_object_keys(payload) as supplied(key)
       where not (supplied.key = any(array['offlineId', 'routeVersionStopId', 'deviceStartedAt', 'location']))
     )
     or (payload ? 'location' and jsonb_typeof(payload -> 'location') <> 'object') then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;

  begin
    v_offline_id := (payload ->> 'offlineId')::uuid;
    v_stop_id := (payload ->> 'routeVersionStopId')::uuid;
    v_device_started_at := (payload ->> 'deviceStartedAt')::timestamptz;
  exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end;
  if v_offline_id is null or v_stop_id is null or v_device_started_at is null
     or v_offline_id <> (p_command ->> 'aggregateId')::uuid
     or v_device_started_at <> (p_command ->> 'occurredAt')::timestamptz then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;

  location_document := payload -> 'location';
  if location_document is not null then
    if not (location_document ?& array['latitude', 'longitude'])
       or exists (
         select 1 from jsonb_object_keys(location_document) as supplied(key)
         where not (supplied.key = any(array['latitude', 'longitude', 'accuracyM', 'distanceM']))
       )
       or location_document ->> 'latitude' !~ '^-?[0-9]+(\.[0-9]+)?$'
       or location_document ->> 'longitude' !~ '^-?[0-9]+(\.[0-9]+)?$'
       or (location_document ? 'accuracyM' and location_document ->> 'accuracyM' !~ '^[0-9]+(\.[0-9]+)?$')
       or (location_document ? 'distanceM' and location_document ->> 'distanceM' !~ '^[0-9]+(\.[0-9]+)?$') then
      raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
    end if;
    begin
      v_latitude := (location_document ->> 'latitude')::numeric;
      v_longitude := (location_document ->> 'longitude')::numeric;
      v_accuracy := case when location_document ? 'accuracyM' then (location_document ->> 'accuracyM')::numeric end;
      v_distance := case when location_document ? 'distanceM' then (location_document ->> 'distanceM')::numeric end;
    exception when numeric_value_out_of_range then
      raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
    end;
    if abs(v_latitude) > 90 or abs(v_longitude) > 180 then
      raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
    end if;
  end if;

  v_payload_hash := encode(extensions.digest(convert_to(payload::text, 'UTF8'), 'sha256'), 'hex');

  select * into existing_visit
  from api.visits visit_row
  where visit_row.seller_id = actor_id
    and visit_row.device_id = p_device_id
    and visit_row.offline_id = v_offline_id
  for update;
  if found then
    if existing_visit.start_payload_hash <> v_payload_hash then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return private.get_visit_start_result(existing_visit.id);
  end if;

  select
    route_row.id as route_id,
    route_row.service_date,
    route_row.seller_id,
    version_row.id as route_version_id,
    version_row.version_number,
    version_row.published_at,
    version_row.seller_context_snapshot,
    stop_row.client_id,
    stop_row.planned_order,
    stop_row.priority,
    stop_row.client_context_snapshot,
    execution_row.status as execution_status
  into stop_context
  from api.route_version_stops stop_row
  join api.route_versions version_row on version_row.id = stop_row.route_version_id
  join api.routes route_row on route_row.id = version_row.route_id
  join api.route_stop_executions execution_row on execution_row.route_version_stop_id = stop_row.id
  where stop_row.id = v_stop_id
    and route_row.seller_id = actor_id
    and route_row.status in ('published', 'in_progress')
    and version_row.status in ('published', 'superseded')
    and version_row.seller_context_snapshot is not null
    and stop_row.client_context_snapshot is not null
  for update of execution_row;

  if not found then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;
  if stop_context.execution_status <> 'pending' then
    raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT';
  end if;

  select * into v_parameter_set
  from api.parameter_sets parameter_row
  where parameter_row.status = 'published'
    and parameter_row.valid_from <= v_device_started_at
  order by parameter_row.version desc
  limit 1;
  if not found then
    raise exception using errcode = 'P0001', message = 'DEPENDENCY_UNAVAILABLE';
  end if;

  context_document := jsonb_build_object(
    'schemaVersion', 1,
    'sourceRouteVersionId', stop_context.route_version_id,
    'snapshotCreatedAt', v_server_started_at,
    'route', jsonb_build_object(
      'id', stop_context.route_id,
      'versionNumber', stop_context.version_number,
      'serviceDate', stop_context.service_date,
      'publishedAt', stop_context.published_at,
      'plannedOrder', stop_context.planned_order,
      'priority', stop_context.priority
    ),
    'client', stop_context.client_context_snapshot,
    'seller', stop_context.seller_context_snapshot,
    'parameters', jsonb_build_object('id', v_parameter_set.id, 'version', v_parameter_set.version)
  );

  insert into api.visits (
    id, offline_id, device_id, route_version_stop_id, route_version_id,
    client_id, seller_id, parameter_set_id, status, context_snapshot,
    start_payload_hash, device_started_at, server_started_at
  ) values (
    v_visit_id, v_offline_id, p_device_id, v_stop_id, stop_context.route_version_id,
    stop_context.client_id, actor_id, v_parameter_set.id, 'in_progress', context_document,
    v_payload_hash, v_device_started_at, v_server_started_at
  );

  if location_document is not null then
    insert into api.location_events (
      visit_id, kind, device_captured_at, server_received_at,
      position, accuracy_m, distance_m
    ) values (
      v_visit_id, 'start', v_device_started_at, v_server_started_at,
      extensions.st_setsrid(extensions.st_makepoint(v_longitude, v_latitude), 4326)::extensions.geography,
      v_accuracy, v_distance
    );
  end if;

  update api.route_stop_executions
  set status = 'in_visit', lock_version = lock_version + 1
  where route_version_stop_id = v_stop_id and status = 'pending';
  if not found then
    raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT';
  end if;

  insert into private.audit_events (
    actor_id, target_type, target_id, action, after_data, origin, occurred_at
  ) values (
    actor_id, 'visit', v_visit_id, 'visit.started.v1',
    jsonb_build_object(
      'visitId', v_visit_id,
      'routeVersionStopId', v_stop_id,
      'parameterSetId', v_parameter_set.id,
      'hasLocation', location_document is not null,
      'status', 'in_progress'
    ),
    'system', v_server_started_at
  );

  return private.get_visit_start_result(v_visit_id);
exception when unique_violation then
  raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT';
end
$function$;

do $sync_replace_ownership$
begin
  execute pg_catalog.format('grant cirne_sync_executor to %I with set true granted by current_user', current_user);
end
$sync_replace_ownership$;
grant create on schema private to cirne_sync_executor;
set local role cirne_sync_executor;
alter table private.sync_events drop constraint sync_events_operation_check;
alter table private.sync_events add constraint sync_events_operation_check
  check (operation in ('visit.draft.saved', 'visit.started.v1'));
alter table private.sync_events drop constraint sync_events_aggregate_type_check;
alter table private.sync_events add constraint sync_events_aggregate_type_check
  check (aggregate_type in ('visit_draft', 'visit'));

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
  visit_result jsonb;
begin
  identity_document := private.resolve_current_identity();
  if identity_document is null or not (identity_document -> 'capabilities' @> '["sync.write_self"]'::jsonb) then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;
  v_actor_id := (identity_document ->> 'id')::uuid;

  if p_device_id is null or jsonb_typeof(p_command) <> 'object'
     or (select count(*) from jsonb_object_keys(p_command)) <> 9
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

  if v_event_id is null or v_idempotency_key is null or v_schema_version is distinct from 1
     or v_event_sequence is null or v_event_sequence < 1 or v_aggregate_id is null
     or v_occurred_at is null or jsonb_typeof(v_payload) <> 'object'
     or not (
       (v_operation = 'visit.draft.saved' and v_aggregate_type = 'visit_draft'
        and (select count(*) from jsonb_object_keys(v_payload)) = 3
        and v_payload ?& array['draftOfflineId', 'routeVersionStopId', 'acknowledged']
        and jsonb_typeof(v_payload -> 'acknowledged') = 'boolean'
        and (v_payload ->> 'draftOfflineId')::uuid = v_aggregate_id)
       or
       (v_operation = 'visit.started.v1' and v_aggregate_type = 'visit'
        and v_event_sequence = 1
        and v_payload ?& array['offlineId', 'routeVersionStopId', 'deviceStartedAt']
        and not exists (
          select 1 from jsonb_object_keys(v_payload) as supplied(key)
          where not (supplied.key = any(array['offlineId', 'routeVersionStopId', 'deviceStartedAt', 'location']))
        )
        and (v_payload ->> 'offlineId')::uuid = v_aggregate_id)
     ) then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;

  v_payload_hash := encode(extensions.digest(convert_to((jsonb_build_object(
    'operation', v_operation,
    'schemaVersion', v_schema_version,
    'aggregateType', v_aggregate_type,
    'aggregateId', v_aggregate_id,
    'sequence', v_event_sequence,
    'occurredAt', to_char(v_occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'payload', v_payload
  ))::text, 'UTF8'), 'sha256'), 'hex');

  perform pg_advisory_xact_lock(hashtextextended(
    v_actor_id::text || ':' || p_device_id::text || ':' || v_operation || ':' || v_idempotency_key::text, 0
  ));

  select * into previous_event from private.sync_events stored
  where stored.actor_id = v_actor_id and stored.device_id = p_device_id
    and stored.operation = v_operation and stored.idempotency_key = v_idempotency_key;
  if found then
    if previous_event.payload_hash <> v_payload_hash then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    if v_operation = 'visit.started.v1' then
      perform private.get_visit_start_result((previous_event.canonical_result ->> 'canonicalId')::uuid);
    end if;
    return previous_event.canonical_result;
  end if;

  if exists (select 1 from private.sync_events stored
    where stored.actor_id = v_actor_id and stored.device_id = p_device_id and stored.event_id = v_event_id) then
    raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSED';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    v_actor_id::text || ':' || p_device_id::text || ':' || v_aggregate_type || ':' || v_aggregate_id::text, 1
  ));
  select max(stored.sequence) into previous_sequence from private.sync_events stored
  where stored.actor_id = v_actor_id and stored.device_id = p_device_id
    and stored.aggregate_type = v_aggregate_type and stored.aggregate_id = v_aggregate_id;
  if v_event_sequence <> coalesce(previous_sequence + 1, 1) then
    raise exception using errcode = 'P0001', message = 'EVENT_OUT_OF_ORDER';
  end if;

  if v_operation = 'visit.started.v1' then
    visit_result := private.apply_visit_started(p_device_id, p_command);
    confirmation_time := (visit_result ->> 'serverStartedAt')::timestamptz;
    canonical_result := jsonb_build_object(
      'eventId', v_event_id,
      'status', 'confirmed',
      'canonicalId', (visit_result ->> 'visitId')::uuid,
      'confirmedAt', to_char(confirmation_time at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    );
  else
    confirmation_time := clock_timestamp();
    canonical_result := jsonb_build_object(
      'eventId', v_event_id,
      'status', 'confirmed',
      'canonicalId', v_aggregate_id,
      'confirmedAt', to_char(confirmation_time at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    );
  end if;

  insert into private.sync_events (
    actor_id, device_id, event_id, idempotency_key, operation, schema_version,
    sequence, payload_hash, aggregate_type, aggregate_id, status, attempt_count,
    canonical_result, occurred_at, confirmed_at
  ) values (
    v_actor_id, p_device_id, v_event_id, v_idempotency_key, v_operation, v_schema_version,
    v_event_sequence, v_payload_hash, v_aggregate_type, v_aggregate_id, 'confirmed', 1,
    canonical_result, v_occurred_at, confirmation_time
  );

  if v_operation = 'visit.draft.saved' then
    insert into private.audit_events (
      actor_id, target_type, target_id, action, after_data, origin, occurred_at
    ) values (
      v_actor_id, v_aggregate_type, v_aggregate_id, v_operation, canonical_result, 'system', confirmation_time
    );
  end if;
  return canonical_result;
exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
  raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
end
$function$;

reset role;
revoke create on schema private from cirne_sync_executor;
do $sync_replace_ownership$
begin
  execute pg_catalog.format('revoke cirne_sync_executor from %I granted by current_user', current_user);
end
$sync_replace_ownership$;

create function private.start_visit(p_device_id uuid, p_idempotency_key uuid, p_command jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  sync_result jsonb;
begin
  if p_device_id is null or p_idempotency_key is null or jsonb_typeof(p_command) <> 'object'
     or not (p_command ?& array['schemaVersion', 'offlineId', 'routeVersionStopId', 'deviceStartedAt'])
     or exists (
       select 1 from jsonb_object_keys(p_command) as supplied(key)
       where not (supplied.key = any(array['schemaVersion', 'offlineId', 'routeVersionStopId', 'deviceStartedAt', 'location']))
     )
     or p_command -> 'schemaVersion' <> '1'::jsonb then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;

  sync_result := private.sync_event(p_device_id, jsonb_build_object(
    'eventId', p_idempotency_key,
    'idempotencyKey', p_idempotency_key,
    'operation', 'visit.started.v1',
    'schemaVersion', 1,
    'sequence', 1,
    'aggregateType', 'visit',
    'aggregateId', p_command -> 'offlineId',
    'occurredAt', p_command -> 'deviceStartedAt',
    'payload', p_command - 'schemaVersion'
  ));
  return private.get_visit_start_result((sync_result ->> 'canonicalId')::uuid);
end
$function$;

create function api.start_visit(p_device_id uuid, p_idempotency_key uuid, p_command jsonb)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $function$
  select private.start_visit(p_device_id, p_idempotency_key, p_command);
$function$;

comment on function api.start_visit(uuid, uuid, jsonb) is
  'Inicia ou reconhece uma visita pelo mesmo nucleo idempotente usado pela sincronizacao.';

do $ownership$
begin
  execute pg_catalog.format('grant cirne_visit_executor to %I with set true granted by current_user', current_user);
end
$ownership$;
alter table api.parameter_sets owner to cirne_visit_executor;
alter table api.visits owner to cirne_visit_executor;
alter table api.location_events owner to cirne_visit_executor;
alter function private.visit_identity() owner to cirne_visit_executor;
alter function private.get_visit_start_result(uuid) owner to cirne_visit_executor;
alter function private.apply_visit_started(uuid, jsonb) owner to cirne_visit_executor;
alter function private.start_visit(uuid, uuid, jsonb) owner to cirne_visit_executor;
alter function api.start_visit(uuid, uuid, jsonb) owner to cirne_visit_executor;
revoke create on schema api, private from cirne_visit_executor;
set local role cirne_visit_executor;
revoke all on function private.visit_identity(), private.get_visit_start_result(uuid),
  private.apply_visit_started(uuid, jsonb), private.start_visit(uuid, uuid, jsonb)
  from public, anon, authenticated;
revoke all on function api.start_visit(uuid, uuid, jsonb) from public, anon;
grant execute on function api.start_visit(uuid, uuid, jsonb) to authenticated;
grant execute on function private.apply_visit_started(uuid, jsonb),
  private.get_visit_start_result(uuid) to cirne_sync_executor;
reset role;
do $ownership$
begin
  execute pg_catalog.format('revoke cirne_visit_executor from %I granted by current_user', current_user);
end
$ownership$;

do $sync_ownership$
begin
  execute pg_catalog.format('grant cirne_sync_executor to %I with set true granted by current_user', current_user);
end
$sync_ownership$;
set local role cirne_sync_executor;
grant execute on function private.sync_event(uuid, jsonb) to cirne_visit_executor;
reset role;
do $sync_ownership$
begin
  execute pg_catalog.format('revoke cirne_sync_executor from %I granted by current_user', current_user);
end
$sync_ownership$;

commit;
