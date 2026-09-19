begin;

do $preflight$
begin
  if to_regclass('api.stock_snapshots') is not null then
    raise exception 'Visit stock expects api.stock_snapshots to be absent';
  end if;
  if to_regprocedure('private.sync_event_before_stock(uuid,jsonb)') is not null then
    raise exception 'Visit stock legacy sync function already exists';
  end if;
end
$preflight$;

do $visit_ownership$
begin
  execute pg_catalog.format('grant cirne_visit_executor to %I with set true granted by current_user', current_user);
end
$visit_ownership$;
set local role cirne_visit_executor;
do $reference_grant$
begin
  execute pg_catalog.format('grant references on table api.visits to %I', session_user);
end
$reference_grant$;
reset role;
do $visit_ownership$
begin
  execute pg_catalog.format('revoke cirne_visit_executor from %I granted by current_user', current_user);
end
$visit_ownership$;

create table api.stock_snapshots (
  id uuid primary key default gen_random_uuid(),
  visit_id uuid not null unique references api.visits(id) on delete restrict,
  heliar_quantity integer not null check (heliar_quantity >= 0),
  moura_quantity integer not null check (moura_quantity >= 0),
  observation text check (observation is null or (char_length(observation) between 1 and 500 and observation = btrim(observation))),
  last_event_id uuid not null,
  device_saved_at timestamptz not null,
  server_saved_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $visit_ownership$
begin
  execute pg_catalog.format('grant cirne_visit_executor to %I with set true granted by current_user', current_user);
end
$visit_ownership$;
set local role cirne_visit_executor;
do $reference_revoke$
begin
  execute pg_catalog.format('revoke references on table api.visits from %I', session_user);
end
$reference_revoke$;
reset role;
do $visit_ownership$
begin
  execute pg_catalog.format('revoke cirne_visit_executor from %I granted by current_user', current_user);
end
$visit_ownership$;

create trigger stock_snapshots_set_updated_at
before update on api.stock_snapshots
for each row execute function private.set_updated_at();

alter table api.stock_snapshots enable row level security;
alter table api.stock_snapshots force row level security;
create policy stock_snapshots_visit_executor_all on api.stock_snapshots
  for all to cirne_visit_executor using (true) with check (true);
revoke all on table api.stock_snapshots from public, anon, authenticated;
grant select, insert, update on table api.stock_snapshots to cirne_visit_executor;

create function private.get_visit_stock_result(p_visit_id uuid)
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
  select jsonb_strip_nulls(jsonb_build_object(
    'schemaVersion', 1,
    'stockSnapshotId', stock_row.id,
    'visitId', visit_row.id,
    'offlineId', visit_row.offline_id,
    'heliarQuantity', stock_row.heliar_quantity,
    'mouraQuantity', stock_row.moura_quantity,
    'observation', stock_row.observation,
    'serverSavedAt', stock_row.server_saved_at
  )) into result_document
  from api.visits visit_row
  join api.stock_snapshots stock_row on stock_row.visit_id = visit_row.id
  where visit_row.id = p_visit_id and visit_row.seller_id = actor_id;

  if result_document is null then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;
  return result_document;
end
$function$;

create function private.apply_visit_stock_saved(p_device_id uuid, p_command jsonb)
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
  v_heliar integer;
  v_moura integer;
  v_observation text;
  v_device_saved_at timestamptz;
  v_server_saved_at timestamptz := clock_timestamp();
  v_event_id uuid := (p_command ->> 'eventId')::uuid;
  visit_row api.visits%rowtype;
  previous_stock jsonb;
begin
  if p_device_id is null or jsonb_typeof(payload) <> 'object'
     or not (payload ?& array['offlineId', 'heliarQuantity', 'mouraQuantity', 'deviceSavedAt'])
     or exists (
       select 1 from jsonb_object_keys(payload) as supplied(key)
       where not (supplied.key = any(array['offlineId', 'heliarQuantity', 'mouraQuantity', 'observation', 'deviceSavedAt']))
     )
     or jsonb_typeof(payload -> 'heliarQuantity') <> 'number'
     or jsonb_typeof(payload -> 'mouraQuantity') <> 'number'
     or (payload ? 'observation' and jsonb_typeof(payload -> 'observation') <> 'string') then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;

  begin
    v_offline_id := (payload ->> 'offlineId')::uuid;
    v_heliar := (payload ->> 'heliarQuantity')::integer;
    v_moura := (payload ->> 'mouraQuantity')::integer;
    v_device_saved_at := (payload ->> 'deviceSavedAt')::timestamptz;
  exception when invalid_text_representation or numeric_value_out_of_range
    or invalid_datetime_format or datetime_field_overflow then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end;
  v_observation := nullif(btrim(payload ->> 'observation'), '');
  if v_offline_id is null or v_offline_id <> (p_command ->> 'aggregateId')::uuid
     or v_heliar < 0 or v_moura < 0
     or (payload ->> 'heliarQuantity') !~ '^[0-9]+$'
     or (payload ->> 'mouraQuantity') !~ '^[0-9]+$'
     or v_device_saved_at is null or v_device_saved_at <> (p_command ->> 'occurredAt')::timestamptz
     or (v_observation is not null and char_length(v_observation) > 500) then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;

  select * into visit_row
  from api.visits candidate
  where candidate.seller_id = actor_id
    and candidate.device_id = p_device_id
    and candidate.offline_id = v_offline_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'EVENT_OUT_OF_ORDER';
  end if;
  if visit_row.status <> 'in_progress' then
    raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT';
  end if;

  select to_jsonb(existing) - array['created_at', 'updated_at'] into previous_stock
  from api.stock_snapshots existing where existing.visit_id = visit_row.id;

  insert into api.stock_snapshots (
    visit_id, heliar_quantity, moura_quantity, observation,
    last_event_id, device_saved_at, server_saved_at
  ) values (
    visit_row.id, v_heliar, v_moura, v_observation,
    v_event_id, v_device_saved_at, v_server_saved_at
  )
  on conflict (visit_id) do update set
    heliar_quantity = excluded.heliar_quantity,
    moura_quantity = excluded.moura_quantity,
    observation = excluded.observation,
    last_event_id = excluded.last_event_id,
    device_saved_at = excluded.device_saved_at,
    server_saved_at = excluded.server_saved_at;

  insert into private.audit_events (
    actor_id, target_type, target_id, action, before_data, after_data, origin, occurred_at
  ) values (
    actor_id, 'visit_stock', visit_row.id, 'visit.stock.saved.v1', previous_stock,
    jsonb_strip_nulls(jsonb_build_object(
      'visitId', visit_row.id,
      'heliarQuantity', v_heliar,
      'mouraQuantity', v_moura,
      'observation', v_observation
    )),
    'system', v_server_saved_at
  );

  return private.get_visit_stock_result(visit_row.id);
end
$function$;

do $sync_ownership$
begin
  execute pg_catalog.format('grant cirne_sync_executor to %I with set true granted by current_user', current_user);
end
$sync_ownership$;
grant create on schema private to cirne_sync_executor;
set local role cirne_sync_executor;

alter table private.sync_events drop constraint sync_events_operation_check;
alter table private.sync_events add constraint sync_events_operation_check
  check (operation in ('visit.draft.saved', 'visit.started.v1', 'visit.stock.saved.v1'));

alter function private.sync_event(uuid, jsonb) rename to sync_event_before_stock;

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
  v_sequence integer;
  v_aggregate_id uuid;
  v_occurred_at timestamptz;
  v_payload jsonb;
  v_payload_hash text;
  previous_event private.sync_events%rowtype;
  previous_sequence integer;
  confirmation_time timestamptz;
  stock_result jsonb;
  canonical_result jsonb;
begin
  if p_command ->> 'operation' is distinct from 'visit.stock.saved.v1' then
    return private.sync_event_before_stock(p_device_id, p_command);
  end if;

  identity_document := private.resolve_current_identity();
  if identity_document is null
     or not (identity_document -> 'capabilities' @> '["sync.write_self"]'::jsonb)
     or not (identity_document -> 'roles' @> '["seller"]'::jsonb) then
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
    v_sequence := (p_command ->> 'sequence')::integer;
    v_aggregate_id := (p_command ->> 'aggregateId')::uuid;
    v_occurred_at := (p_command ->> 'occurredAt')::timestamptz;
    v_payload := p_command -> 'payload';
  exception when invalid_text_representation or numeric_value_out_of_range
    or invalid_datetime_format or datetime_field_overflow then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end;
  if v_event_id is null or v_idempotency_key is null
     or (p_command ->> 'schemaVersion')::integer is distinct from 1
     or v_sequence < 2 or p_command ->> 'aggregateType' is distinct from 'visit'
     or v_aggregate_id is null or v_occurred_at is null or jsonb_typeof(v_payload) <> 'object'
     or (v_payload ->> 'offlineId')::uuid <> v_aggregate_id then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;

  v_payload_hash := encode(extensions.digest(convert_to((jsonb_build_object(
    'operation', 'visit.stock.saved.v1',
    'schemaVersion', 1,
    'aggregateType', 'visit',
    'aggregateId', v_aggregate_id,
    'sequence', v_sequence,
    'occurredAt', to_char(v_occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'payload', v_payload
  ))::text, 'UTF8'), 'sha256'), 'hex');

  perform pg_advisory_xact_lock(hashtextextended(
    v_actor_id::text || ':' || p_device_id::text || ':visit.stock.saved.v1:' || v_idempotency_key::text, 0
  ));
  select * into previous_event from private.sync_events stored
  where stored.actor_id = v_actor_id and stored.device_id = p_device_id
    and stored.operation = 'visit.stock.saved.v1' and stored.idempotency_key = v_idempotency_key;
  if found then
    if previous_event.payload_hash <> v_payload_hash then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    perform private.get_visit_stock_result((previous_event.canonical_result ->> 'canonicalId')::uuid);
    return previous_event.canonical_result;
  end if;
  if exists (select 1 from private.sync_events stored
    where stored.actor_id = v_actor_id and stored.device_id = p_device_id and stored.event_id = v_event_id) then
    raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSED';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    v_actor_id::text || ':' || p_device_id::text || ':visit:' || v_aggregate_id::text, 1
  ));
  select max(stored.sequence) into previous_sequence from private.sync_events stored
  where stored.actor_id = v_actor_id and stored.device_id = p_device_id
    and stored.aggregate_type = 'visit' and stored.aggregate_id = v_aggregate_id;
  if previous_sequence is null or v_sequence <> previous_sequence + 1 then
    raise exception using errcode = 'P0001', message = 'EVENT_OUT_OF_ORDER';
  end if;

  stock_result := private.apply_visit_stock_saved(p_device_id, p_command);
  confirmation_time := (stock_result ->> 'serverSavedAt')::timestamptz;
  canonical_result := jsonb_build_object(
    'eventId', v_event_id,
    'status', 'confirmed',
    'canonicalId', (stock_result ->> 'visitId')::uuid,
    'confirmedAt', to_char(confirmation_time at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
  insert into private.sync_events (
    actor_id, device_id, event_id, idempotency_key, operation, schema_version,
    sequence, payload_hash, aggregate_type, aggregate_id, status, attempt_count,
    canonical_result, occurred_at, confirmed_at
  ) values (
    v_actor_id, p_device_id, v_event_id, v_idempotency_key, 'visit.stock.saved.v1', 1,
    v_sequence, v_payload_hash, 'visit', v_aggregate_id, 'confirmed', 1,
    canonical_result, v_occurred_at, confirmation_time
  );
  return canonical_result;
exception when invalid_text_representation or numeric_value_out_of_range
  or invalid_datetime_format or datetime_field_overflow then
  raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
end
$function$;

reset role;
revoke create on schema private from cirne_sync_executor;
do $sync_ownership$
begin
  execute pg_catalog.format('revoke cirne_sync_executor from %I granted by current_user', current_user);
end
$sync_ownership$;

create function private.save_visit_stock(p_device_id uuid, p_idempotency_key uuid, p_command jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  identity_document jsonb := private.resolve_current_identity();
  actor_id uuid := (identity_document ->> 'id')::uuid;
  v_offline_id uuid;
  v_event_id uuid;
  v_sequence integer;
  previous_event private.sync_events%rowtype;
  sync_result jsonb;
begin
  if identity_document is null
     or not (identity_document -> 'capabilities' @> '["visit.start_self"]'::jsonb)
     or not (identity_document -> 'roles' @> '["seller"]'::jsonb) then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;
  if p_device_id is null or p_idempotency_key is null or jsonb_typeof(p_command) <> 'object'
     or not (p_command ?& array['schemaVersion', 'offlineId', 'heliarQuantity', 'mouraQuantity', 'deviceSavedAt'])
     or exists (
       select 1 from jsonb_object_keys(p_command) as supplied(key)
       where not (supplied.key = any(array['schemaVersion', 'offlineId', 'heliarQuantity', 'mouraQuantity', 'observation', 'deviceSavedAt']))
     ) then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  begin
    v_offline_id := (p_command ->> 'offlineId')::uuid;
  exception when invalid_text_representation then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end;
  perform pg_advisory_xact_lock(hashtextextended(
    actor_id::text || ':' || p_device_id::text || ':visit:' || v_offline_id::text, 1
  ));
  select * into previous_event from private.sync_events stored
  where stored.actor_id = actor_id and stored.device_id = p_device_id
    and stored.operation = 'visit.stock.saved.v1' and stored.idempotency_key = p_idempotency_key;
  if found then
    v_event_id := previous_event.event_id;
    v_sequence := previous_event.sequence;
  else
    v_event_id := p_idempotency_key;
    select coalesce(max(stored.sequence), 0) + 1 into v_sequence
    from private.sync_events stored
    where stored.actor_id = actor_id and stored.device_id = p_device_id
      and stored.aggregate_type = 'visit' and stored.aggregate_id = v_offline_id;
  end if;
  sync_result := private.sync_event(p_device_id, jsonb_build_object(
    'eventId', v_event_id,
    'idempotencyKey', p_idempotency_key,
    'operation', 'visit.stock.saved.v1',
    'schemaVersion', 1,
    'sequence', v_sequence,
    'aggregateType', 'visit',
    'aggregateId', v_offline_id,
    'occurredAt', p_command ->> 'deviceSavedAt',
    'payload', p_command - 'schemaVersion'
  ));
  return private.get_visit_stock_result((sync_result ->> 'canonicalId')::uuid);
end
$function$;

create function api.save_visit_stock(p_device_id uuid, p_idempotency_key uuid, p_command jsonb)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $function$
  select private.save_visit_stock(p_device_id, p_idempotency_key, p_command);
$function$;

do $final_ownership$
begin
  execute pg_catalog.format('grant cirne_visit_executor to %I with set true granted by current_user', current_user);
  execute pg_catalog.format('grant cirne_sync_executor to %I with set true granted by current_user', current_user);
end
$final_ownership$;
grant create on schema api, private to cirne_visit_executor;
grant create on schema private to cirne_sync_executor;
alter table api.stock_snapshots owner to cirne_visit_executor;
alter function private.get_visit_stock_result(uuid) owner to cirne_visit_executor;
alter function private.apply_visit_stock_saved(uuid, jsonb) owner to cirne_visit_executor;
alter function private.save_visit_stock(uuid, uuid, jsonb) owner to cirne_sync_executor;
alter function api.save_visit_stock(uuid, uuid, jsonb) owner to cirne_visit_executor;

revoke create on schema api, private from cirne_visit_executor;
revoke create on schema private from cirne_sync_executor;

set local role cirne_visit_executor;
revoke all on function private.get_visit_stock_result(uuid),
  private.apply_visit_stock_saved(uuid, jsonb)
  from public, anon, authenticated;
revoke all on function api.save_visit_stock(uuid, uuid, jsonb) from public, anon;
grant execute on function api.save_visit_stock(uuid, uuid, jsonb) to authenticated;
grant execute on function private.get_visit_stock_result(uuid),
  private.apply_visit_stock_saved(uuid, jsonb) to cirne_sync_executor;
reset role;

set local role cirne_sync_executor;
revoke all on function private.save_visit_stock(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function private.save_visit_stock(uuid, uuid, jsonb) to cirne_visit_executor;
grant execute on function private.sync_event(uuid, jsonb) to cirne_visit_executor;
reset role;

do $final_ownership$
begin
  execute pg_catalog.format('revoke cirne_visit_executor from %I granted by current_user', current_user);
  execute pg_catalog.format('revoke cirne_sync_executor from %I granted by current_user', current_user);
end
$final_ownership$;

commit;
