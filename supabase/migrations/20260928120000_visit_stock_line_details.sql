-- Story 3.4: additive line details for own and competitor stock.
begin;
select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cirne:database:migrate'));
set local lock_timeout = '5s';

do $role_setup$
begin
  execute pg_catalog.format('grant cirne_visit_executor to %I with set true granted by current_user', current_user);
  execute pg_catalog.format('grant cirne_sync_executor to %I with set true granted by current_user', current_user);
end
$role_setup$;
grant create on schema private to cirne_visit_executor;
grant create on schema private to cirne_sync_executor;
set local role cirne_visit_executor;

alter table api.stock_snapshots
  add column if not exists details jsonb not null default '{"ownLines":[]}'::jsonb;
alter table api.stock_snapshots
  alter column details set default '{"ownLines":[]}'::jsonb;

alter table api.stock_snapshots
  drop constraint if exists stock_snapshots_details_shape_check;
alter table api.stock_snapshots
  add constraint stock_snapshots_details_shape_check check (
    jsonb_typeof(details) is not distinct from 'object'
    and jsonb_typeof(details -> 'ownLines') is not distinct from 'array'
    and (not (details ? 'competitorLines') or jsonb_typeof(details -> 'competitorLines') is not distinct from 'array')
    and (not (details ? 'completedOwnBrands') or jsonb_typeof(details -> 'completedOwnBrands') is not distinct from 'array')
  );

create or replace function private.validate_visit_stock_details(p_details jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $function$
declare
  line jsonb;
  brand text;
  quantity integer;
  completed_brands text[] := '{}';
begin
  if p_details is null or jsonb_typeof(p_details) is distinct from 'object'
     or jsonb_typeof(p_details -> 'ownLines') is distinct from 'array'
     or (p_details ? 'competitorLines' and jsonb_typeof(p_details -> 'competitorLines') is distinct from 'array')
     or jsonb_array_length(p_details -> 'ownLines') > 200
     or jsonb_array_length(coalesce(p_details -> 'competitorLines', '[]'::jsonb)) > 200 then
    return false;
  end if;
  if p_details ? 'completedOwnBrands' then
    if jsonb_typeof(p_details -> 'completedOwnBrands') is distinct from 'array'
       or jsonb_array_length(p_details -> 'completedOwnBrands') > 4 then
      return false;
    end if;
    for brand in select value #>> '{}' from jsonb_array_elements(p_details -> 'completedOwnBrands') loop
      if brand is null or brand not in ('Heliar', 'América', 'Durex', 'ACDelco')
         or brand = any(completed_brands) then
        return false;
      end if;
      completed_brands := array_append(completed_brands, brand);
    end loop;
  end if;
  for line in select value from jsonb_array_elements(p_details -> 'ownLines') loop
    if jsonb_typeof(line) <> 'object' then return false; end if;
    brand := line ->> 'brand';
    if brand is null or brand not in ('Heliar', 'América', 'Durex', 'ACDelco')
       or exists (select 1 from jsonb_object_keys(line) supplied(key)
         where not (supplied.key = any(array['brand', 'model', 'quantity'])))
       or jsonb_typeof(line -> 'model') is distinct from 'string'
       or char_length(btrim(line ->> 'model')) not between 1 and 120
       or jsonb_typeof(line -> 'quantity') is distinct from 'number'
       or (line ->> 'quantity') !~ '^[0-9]+$' then
      return false;
    end if;
    quantity := (line ->> 'quantity')::integer;
    if quantity < 0 then return false; end if;
  end loop;
  for line in select value from jsonb_array_elements(coalesce(p_details -> 'competitorLines', '[]'::jsonb)) loop
    if jsonb_typeof(line) <> 'object' then return false; end if;
    brand := line ->> 'brand';
    if brand is null or brand not in ('Moura', 'Zetta', 'Bosh', 'Tudor', 'Pioneiro', 'Outra')
       or exists (select 1 from jsonb_object_keys(line) supplied(key)
         where not (supplied.key = any(array['brand', 'amperage', 'technology', 'quantity', 'otherBrand'])))
       or jsonb_typeof(line -> 'amperage') is distinct from 'number'
       or (line ->> 'amperage') !~ '^[0-9]+$'
       or ((line ->> 'amperage')::integer not between 1 and 999)
       or jsonb_typeof(line -> 'technology') is distinct from 'string'
       or char_length(btrim(line ->> 'technology')) not between 1 and 60
       or jsonb_typeof(line -> 'quantity') is distinct from 'number'
       or (line ->> 'quantity') !~ '^[0-9]+$'
       or (line ->> 'quantity')::integer < 0
       or (brand = 'Outra' and (jsonb_typeof(line -> 'otherBrand') is distinct from 'string' or char_length(btrim(line ->> 'otherBrand')) not between 1 and 80)) then
      return false;
    end if;
  end loop;
  return true;
exception when invalid_text_representation or numeric_value_out_of_range then
  return false;
end
$function$;

revoke all on function private.validate_visit_stock_details(jsonb) from public, anon, authenticated;

create or replace function private.get_visit_stock_result(p_visit_id uuid)
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
    'ownLines', coalesce(stock_row.details -> 'ownLines', '[]'::jsonb),
    'completedOwnBrands', stock_row.details -> 'completedOwnBrands',
    'competitorLines', stock_row.details -> 'competitorLines',
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

create or replace function private.apply_visit_stock_saved(p_device_id uuid, p_command jsonb)
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
  details jsonb;
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
     or exists (select 1 from jsonb_object_keys(payload) supplied(key) where not (supplied.key = any(array['offlineId', 'heliarQuantity', 'mouraQuantity', 'ownLines', 'completedOwnBrands', 'competitorLines', 'observation', 'deviceSavedAt'])))
     or jsonb_typeof(payload -> 'heliarQuantity') <> 'number'
     or jsonb_typeof(payload -> 'mouraQuantity') <> 'number'
     or (payload ? 'observation' and jsonb_typeof(payload -> 'observation') <> 'string')
     or (payload ? 'ownLines' and jsonb_typeof(payload -> 'ownLines') <> 'array')
     or (payload ? 'completedOwnBrands' and jsonb_typeof(payload -> 'completedOwnBrands') <> 'array')
     or (payload ? 'competitorLines' and jsonb_typeof(payload -> 'competitorLines') <> 'array') then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  details := jsonb_build_object('ownLines', coalesce(payload -> 'ownLines', '[]'::jsonb))
    || case when payload ? 'competitorLines' then jsonb_build_object('competitorLines', payload -> 'competitorLines') else '{}'::jsonb end
    || case when payload ? 'completedOwnBrands' then jsonb_build_object('completedOwnBrands', payload -> 'completedOwnBrands') else '{}'::jsonb end;
  if not private.validate_visit_stock_details(details) then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  begin
    v_offline_id := (payload ->> 'offlineId')::uuid;
    v_heliar := (payload ->> 'heliarQuantity')::integer;
    v_moura := (payload ->> 'mouraQuantity')::integer;
    v_device_saved_at := (payload ->> 'deviceSavedAt')::timestamptz;
  exception when invalid_text_representation or numeric_value_out_of_range or invalid_datetime_format or datetime_field_overflow then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end;
  v_observation := nullif(btrim(payload ->> 'observation'), '');
  if v_offline_id is null or v_offline_id <> (p_command ->> 'aggregateId')::uuid or v_heliar < 0 or v_moura < 0
     or (payload ->> 'heliarQuantity') !~ '^[0-9]+$' or (payload ->> 'mouraQuantity') !~ '^[0-9]+$'
     or v_device_saved_at is null or v_device_saved_at <> (p_command ->> 'occurredAt')::timestamptz
     or (v_observation is not null and char_length(v_observation) > 500) then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  select * into visit_row from api.visits candidate where candidate.seller_id = actor_id and candidate.device_id = p_device_id and candidate.offline_id = v_offline_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'EVENT_OUT_OF_ORDER'; end if;
  if visit_row.status <> 'in_progress' then raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT'; end if;
  select to_jsonb(existing) - array['created_at', 'updated_at'] into previous_stock from api.stock_snapshots existing where existing.visit_id = visit_row.id;
  insert into api.stock_snapshots (visit_id, heliar_quantity, moura_quantity, observation, details, last_event_id, device_saved_at, server_saved_at)
  values (visit_row.id, v_heliar, v_moura, v_observation, details, v_event_id, v_device_saved_at, v_server_saved_at)
  on conflict (visit_id) do update set heliar_quantity = excluded.heliar_quantity, moura_quantity = excluded.moura_quantity, observation = excluded.observation, details = excluded.details, last_event_id = excluded.last_event_id, device_saved_at = excluded.device_saved_at, server_saved_at = excluded.server_saved_at;
  insert into private.audit_events (actor_id, target_type, target_id, action, before_data, after_data, origin, occurred_at)
  values (actor_id, 'visit_stock', visit_row.id, 'visit.stock.saved.v1', previous_stock, jsonb_strip_nulls(jsonb_build_object('visitId', visit_row.id, 'heliarQuantity', v_heliar, 'mouraQuantity', v_moura, 'ownLines', details -> 'ownLines', 'completedOwnBrands', details -> 'completedOwnBrands', 'competitorLines', details -> 'competitorLines', 'observation', v_observation)), 'system', v_server_saved_at);
  return private.get_visit_stock_result(visit_row.id);
end
$function$;

reset role;
revoke create on schema private from cirne_visit_executor;
set local role cirne_sync_executor;

create or replace function private.save_visit_stock(p_device_id uuid, p_idempotency_key uuid, p_command jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  identity_document jsonb := private.resolve_current_identity();
  v_actor_id uuid := (identity_document ->> 'id')::uuid;
  v_offline_id uuid;
  v_event_id uuid;
  v_sequence integer;
  previous_event private.sync_events%rowtype;
  sync_result jsonb;
  v_confirmed_at timestamptz;
begin
  if identity_document is null
     or not (identity_document -> 'capabilities' @> '["visit.start_self"]'::jsonb)
     or not (identity_document -> 'roles' @> '["seller"]'::jsonb) then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;
  if p_device_id is null or p_idempotency_key is null or jsonb_typeof(p_command) is distinct from 'object'
     or p_command -> 'schemaVersion' is distinct from '1'::jsonb
     or not (p_command ?& array['schemaVersion', 'offlineId', 'heliarQuantity', 'mouraQuantity', 'deviceSavedAt'])
     or exists (select 1 from jsonb_object_keys(p_command) supplied(key)
       where not (supplied.key = any(array['schemaVersion', 'offlineId', 'heliarQuantity', 'mouraQuantity', 'ownLines', 'completedOwnBrands', 'competitorLines', 'observation', 'deviceSavedAt']))) then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  begin
    v_offline_id := (p_command ->> 'offlineId')::uuid;
  exception when invalid_text_representation then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end;

  -- Match private.sync_event: intention lock before aggregate lock.
  perform pg_advisory_xact_lock(hashtextextended(
    v_actor_id::text || ':' || p_device_id::text || ':visit.stock.saved.v1:' || p_idempotency_key::text, 0));
  perform pg_advisory_xact_lock(hashtextextended(
    v_actor_id::text || ':' || p_device_id::text || ':visit:' || v_offline_id::text, 1));
  select * into previous_event from private.sync_events stored
  where stored.actor_id = v_actor_id and stored.device_id = p_device_id
    and stored.operation = 'visit.stock.saved.v1' and stored.idempotency_key = p_idempotency_key;
  if found then
    v_event_id := previous_event.event_id;
    v_sequence := previous_event.sequence;
  else
    v_event_id := p_idempotency_key;
    select coalesce(max(stored.sequence), 0) + 1 into v_sequence
    from private.sync_events stored
    where stored.actor_id = v_actor_id and stored.device_id = p_device_id
      and stored.aggregate_type = 'visit' and stored.aggregate_id = v_offline_id;
  end if;
  sync_result := private.sync_event(p_device_id, jsonb_build_object(
    'eventId', v_event_id, 'idempotencyKey', p_idempotency_key,
    'operation', 'visit.stock.saved.v1', 'schemaVersion', 1,
    'sequence', v_sequence, 'aggregateType', 'visit', 'aggregateId', v_offline_id,
    'occurredAt', p_command ->> 'deviceSavedAt', 'payload', p_command - 'schemaVersion'));
  select stored.confirmed_at into strict v_confirmed_at
  from private.sync_events stored
  where stored.actor_id = v_actor_id and stored.device_id = p_device_id
    and stored.operation = 'visit.stock.saved.v1' and stored.idempotency_key = p_idempotency_key;
  return jsonb_strip_nulls(private.get_visit_stock_result((sync_result ->> 'canonicalId')::uuid)
    || jsonb_build_object(
      'heliarQuantity', (p_command ->> 'heliarQuantity')::integer,
      'mouraQuantity', (p_command ->> 'mouraQuantity')::integer,
      'ownLines', coalesce(p_command -> 'ownLines', '[]'::jsonb),
      'completedOwnBrands', p_command -> 'completedOwnBrands',
      'competitorLines', p_command -> 'competitorLines',
      'observation', nullif(btrim(p_command ->> 'observation'), ''),
      'serverSavedAt', v_confirmed_at));
end
$function$;

reset role;
revoke create on schema private from cirne_sync_executor;
alter function private.validate_visit_stock_details(jsonb) owner to cirne_visit_executor;
alter function private.get_visit_stock_result(uuid) owner to cirne_visit_executor;
alter function private.apply_visit_stock_saved(uuid, jsonb) owner to cirne_visit_executor;
alter function private.save_visit_stock(uuid, uuid, jsonb) owner to cirne_sync_executor;
do $role_cleanup$
begin
  execute pg_catalog.format('revoke cirne_visit_executor from %I granted by current_user', current_user);
  execute pg_catalog.format('revoke cirne_sync_executor from %I granted by current_user', current_user);
end
$role_cleanup$;

commit;
