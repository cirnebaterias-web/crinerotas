-- Story 3.3: parameterized competitor prices, explicit unavailability and offline sync.
-- No operational catalog values are seeded while AB-02 remains open.
begin;
select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cirne:database:migrate'));
set local lock_timeout = '5s';

do $preflight$
begin
  if to_regclass('api.parameter_values') is not null
     or to_regclass('api.competitor_price_reports') is not null
     or to_regclass('api.competitor_prices') is not null
     or to_regclass('private.competitor_price_receipts') is not null then
    raise exception 'Visit competitor prices expects its tables to be absent';
  end if;
  if to_regprocedure('private.sync_event(uuid,jsonb)') is null
     or to_regprocedure('private.sync_event_before_prices(uuid,jsonb)') is not null
     or to_regclass('api.stock_snapshots') is null then
    raise exception 'Visit competitor prices requires the current stock and sync capabilities';
  end if;
end
$preflight$;

-- The referenced visit tables are owned by the least-privilege visit role.
-- Grant REFERENCES only for DDL creation and revoke it immediately afterwards.
do $visit_ownership$
begin
  execute pg_catalog.format('grant cirne_visit_executor to %I with set true granted by current_user', current_user);
end
$visit_ownership$;
set local role cirne_visit_executor;
do $reference_grant$
begin
  execute pg_catalog.format('grant references on table api.parameter_sets, api.visits to %I', session_user);
end
$reference_grant$;
reset role;
do $visit_ownership$
begin
  execute pg_catalog.format('revoke cirne_visit_executor from %I granted by current_user', current_user);
end
$visit_ownership$;

create table api.parameter_values (
  id uuid primary key default gen_random_uuid(),
  parameter_set_id uuid not null references api.parameter_sets(id) on delete restrict,
  category text not null check (category in (
    'competitor',
    'competitor_price_technology',
    'competitor_price_condition',
    'competitor_price_unavailable_reason'
  )),
  code text not null check (code ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  label text not null check (char_length(btrim(label)) between 1 and 120 and label = btrim(label)),
  sort_order integer not null default 0 check (sort_order >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint parameter_values_set_category_code_key unique (parameter_set_id, category, code),
  constraint parameter_values_id_set_category_key unique (id, parameter_set_id, category)
);

create table api.competitor_price_reports (
  id uuid primary key default gen_random_uuid(),
  visit_id uuid not null unique references api.visits(id) on delete restrict,
  parameter_set_id uuid not null,
  availability text not null check (availability in ('available', 'unavailable')),
  unavailable_reason_id uuid,
  unavailable_reason_category text not null default 'competitor_price_unavailable_reason'
    check (unavailable_reason_category = 'competitor_price_unavailable_reason'),
  last_event_id uuid not null,
  device_saved_at timestamptz not null,
  server_saved_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint competitor_price_reports_id_parameter_set_key unique (id, parameter_set_id),
  constraint competitor_price_reports_visit_parameter_set_fkey
    foreign key (visit_id, parameter_set_id)
    references api.visits(id, parameter_set_id) on delete restrict,
  constraint competitor_price_reports_reason_fkey
    foreign key (unavailable_reason_id, parameter_set_id, unavailable_reason_category)
    references api.parameter_values(id, parameter_set_id, category) on delete restrict,
  constraint competitor_price_reports_response_check check (
    (availability = 'available' and unavailable_reason_id is null)
    or (availability = 'unavailable' and unavailable_reason_id is not null)
  )
);

create table api.competitor_prices (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null,
  parameter_set_id uuid not null,
  competitor_id uuid not null,
  competitor_category text not null default 'competitor'
    check (competitor_category = 'competitor'),
  model_or_amperage text not null
    check (char_length(btrim(model_or_amperage)) between 1 and 120 and model_or_amperage = btrim(model_or_amperage)),
  technology_id uuid not null,
  technology_category text not null default 'competitor_price_technology'
    check (technology_category = 'competitor_price_technology'),
  price_brl numeric not null check (price_brl > 0),
  condition_id uuid not null,
  condition_category text not null default 'competitor_price_condition'
    check (condition_category = 'competitor_price_condition'),
  observation text
    check (observation is null or (char_length(observation) between 1 and 500 and observation = btrim(observation))),
  ordinal integer not null check (ordinal between 1 and 25),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint competitor_prices_report_ordinal_key unique (report_id, ordinal),
  constraint competitor_prices_report_parameter_set_fkey
    foreign key (report_id, parameter_set_id)
    references api.competitor_price_reports(id, parameter_set_id) on delete restrict,
  constraint competitor_prices_competitor_fkey
    foreign key (competitor_id, parameter_set_id, competitor_category)
    references api.parameter_values(id, parameter_set_id, category) on delete restrict,
  constraint competitor_prices_technology_fkey
    foreign key (technology_id, parameter_set_id, technology_category)
    references api.parameter_values(id, parameter_set_id, category) on delete restrict,
  constraint competitor_prices_condition_fkey
    foreign key (condition_id, parameter_set_id, condition_category)
    references api.parameter_values(id, parameter_set_id, category) on delete restrict
);

create table private.competitor_price_receipts (
  event_id uuid primary key,
  visit_id uuid not null references api.visits(id) on delete restrict,
  result_document jsonb not null,
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
  execute pg_catalog.format('revoke references on table api.parameter_sets, api.visits from %I', session_user);
end
$reference_revoke$;
reset role;
do $visit_ownership$
begin
  execute pg_catalog.format('revoke cirne_visit_executor from %I granted by current_user', current_user);
end
$visit_ownership$;

create index parameter_values_catalog_idx
  on api.parameter_values (parameter_set_id, category, sort_order, id);
create index competitor_prices_competitor_created_idx
  on api.competitor_prices (competitor_id, created_at desc);

create trigger parameter_values_set_updated_at before update on api.parameter_values
for each row execute function private.set_updated_at();
create trigger competitor_price_reports_set_updated_at before update on api.competitor_price_reports
for each row execute function private.set_updated_at();
create trigger competitor_prices_set_updated_at before update on api.competitor_prices
for each row execute function private.set_updated_at();
create trigger competitor_price_receipts_set_updated_at before update on private.competitor_price_receipts
for each row execute function private.set_updated_at();

create function private.guard_published_parameter_values()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
begin
  if tg_op <> 'INSERT' and not exists (
    select 1 from api.parameter_sets candidate
    where candidate.id = old.parameter_set_id and candidate.status = 'draft'
  ) then
    raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT';
  end if;
  if tg_op <> 'DELETE' and not exists (
    select 1 from api.parameter_sets candidate
    where candidate.id = new.parameter_set_id and candidate.status = 'draft'
  ) then
    raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$function$;

create trigger parameter_values_guard_published
before insert or update or delete on api.parameter_values
for each row execute function private.guard_published_parameter_values();

alter table api.parameter_values enable row level security;
alter table api.parameter_values force row level security;
alter table api.competitor_price_reports enable row level security;
alter table api.competitor_price_reports force row level security;
alter table api.competitor_prices enable row level security;
alter table api.competitor_prices force row level security;
alter table private.competitor_price_receipts enable row level security;
alter table private.competitor_price_receipts force row level security;

create policy parameter_values_visit_executor_all on api.parameter_values
  for all to cirne_visit_executor using (true) with check (true);
create policy competitor_price_reports_visit_executor_all on api.competitor_price_reports
  for all to cirne_visit_executor using (true) with check (true);
create policy competitor_prices_visit_executor_all on api.competitor_prices
  for all to cirne_visit_executor using (true) with check (true);
create policy competitor_price_receipts_visit_executor_all on private.competitor_price_receipts
  for all to cirne_visit_executor using (true) with check (true);

revoke all on table api.parameter_values, api.competitor_price_reports, api.competitor_prices,
  private.competitor_price_receipts from public, anon, authenticated;
grant select on table api.parameter_values to cirne_visit_executor;
grant select, insert, update, delete on table api.competitor_price_reports, api.competitor_prices,
  private.competitor_price_receipts to cirne_visit_executor;
grant select, insert, update, delete on table api.parameter_values to service_role;

create function private.get_visit_competitor_prices_result(p_event_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  identity_document jsonb := private.visit_identity();
  v_actor_id uuid := (identity_document ->> 'id')::uuid;
  v_result jsonb;
begin
  select receipt.result_document into v_result
  from private.competitor_price_receipts receipt
  join api.visits visit_row on visit_row.id = receipt.visit_id
  where receipt.event_id = p_event_id and visit_row.seller_id = v_actor_id;
  if v_result is null then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;
  return v_result;
end
$function$;

create function private.apply_visit_competitor_prices_saved(p_device_id uuid, p_command jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  identity_document jsonb := private.visit_identity();
  v_actor_id uuid := (identity_document ->> 'id')::uuid;
  v_payload jsonb := p_command -> 'payload';
  v_availability text;
  v_offline_id uuid;
  v_reason_id uuid;
  v_device_saved_at timestamptz;
  v_server_saved_at timestamptz := clock_timestamp();
  v_event_id uuid := (p_command ->> 'eventId')::uuid;
  v_report_id uuid;
  v_quote jsonb;
  v_quotation_ids jsonb := '[]'::jsonb;
  v_ordinal integer;
  v_competitor_id uuid;
  v_technology_id uuid;
  v_condition_id uuid;
  v_price numeric;
  v_observation text;
  v_result jsonb;
  v_before jsonb;
  visit_row api.visits%rowtype;
begin
  if p_device_id is null or jsonb_typeof(v_payload) <> 'object'
     or not (v_payload ?& array['offlineId', 'availability', 'deviceSavedAt']) then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  begin
    v_offline_id := (v_payload ->> 'offlineId')::uuid;
    v_device_saved_at := (v_payload ->> 'deviceSavedAt')::timestamptz;
    v_availability := v_payload ->> 'availability';
  exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end;
  if v_offline_id is null or v_offline_id <> (p_command ->> 'aggregateId')::uuid
     or v_device_saved_at is null or v_device_saved_at <> (p_command ->> 'occurredAt')::timestamptz
     or v_availability not in ('available', 'unavailable') then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;

  if v_availability = 'available' then
    if not (v_payload ? 'quotations') or jsonb_typeof(v_payload -> 'quotations') <> 'array'
       or jsonb_array_length(v_payload -> 'quotations') not between 1 and 25
       or exists (select 1 from jsonb_object_keys(v_payload) supplied(key)
         where not (supplied.key = any(array['offlineId', 'availability', 'quotations', 'deviceSavedAt']))) then
      raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
    end if;
  else
    if not (v_payload ? 'unavailableReasonId')
       or exists (select 1 from jsonb_object_keys(v_payload) supplied(key)
         where not (supplied.key = any(array['offlineId', 'availability', 'unavailableReasonId', 'deviceSavedAt']))) then
      raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
    end if;
    begin
      v_reason_id := (v_payload ->> 'unavailableReasonId')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
    end;
  end if;

  select * into visit_row
  from api.visits candidate
  where candidate.seller_id = v_actor_id
    and candidate.device_id = p_device_id
    and candidate.offline_id = v_offline_id
  for update;
  if not found or not exists (
    select 1 from api.stock_snapshots stock where stock.visit_id = visit_row.id
  ) then
    raise exception using errcode = 'P0001', message = 'EVENT_OUT_OF_ORDER';
  end if;
  if visit_row.status <> 'in_progress' then
    raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT';
  end if;

  select jsonb_build_object(
    'report', to_jsonb(report) - array['created_at', 'updated_at'],
    'quotations', coalesce((select jsonb_agg(to_jsonb(price) - array['created_at', 'updated_at'] order by price.ordinal)
      from api.competitor_prices price where price.report_id = report.id), '[]'::jsonb)
  ) into v_before
  from api.competitor_price_reports report where report.visit_id = visit_row.id;

  if v_availability = 'unavailable' and not exists (
    select 1 from api.parameter_values value
    where value.id = v_reason_id and value.parameter_set_id = visit_row.parameter_set_id
      and value.category = 'competitor_price_unavailable_reason'
  ) then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;

  insert into api.competitor_price_reports (
    visit_id, parameter_set_id, availability, unavailable_reason_id,
    last_event_id, device_saved_at, server_saved_at
  ) values (
    visit_row.id, visit_row.parameter_set_id, v_availability, v_reason_id,
    v_event_id, v_device_saved_at, v_server_saved_at
  ) on conflict (visit_id) do update set
    availability = excluded.availability,
    unavailable_reason_id = excluded.unavailable_reason_id,
    last_event_id = excluded.last_event_id,
    device_saved_at = excluded.device_saved_at,
    server_saved_at = excluded.server_saved_at
  returning id into v_report_id;

  delete from api.competitor_prices where report_id = v_report_id;
  if v_availability = 'available' then
    for v_quote, v_ordinal in
      select item.value, item.ordinality::integer
      from jsonb_array_elements(v_payload -> 'quotations') with ordinality as item(value, ordinality)
    loop
      if jsonb_typeof(v_quote) <> 'object'
         or not (v_quote ?& array['competitorId', 'modelOrAmperage', 'technologyId', 'priceBrl', 'conditionId'])
         or exists (select 1 from jsonb_object_keys(v_quote) supplied(key)
           where not (supplied.key = any(array[
             'competitorId', 'modelOrAmperage', 'technologyId', 'priceBrl', 'conditionId', 'observation'
           ])))
         or jsonb_typeof(v_quote -> 'modelOrAmperage') <> 'string'
         or jsonb_typeof(v_quote -> 'priceBrl') <> 'string'
         or (v_quote ? 'observation' and jsonb_typeof(v_quote -> 'observation') <> 'string')
         or v_quote ->> 'priceBrl' !~ '^[0-9]+(\.[0-9]+)?$' then
        raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
      end if;
      begin
        v_competitor_id := (v_quote ->> 'competitorId')::uuid;
        v_technology_id := (v_quote ->> 'technologyId')::uuid;
        v_condition_id := (v_quote ->> 'conditionId')::uuid;
        v_price := (v_quote ->> 'priceBrl')::numeric;
      exception when invalid_text_representation or numeric_value_out_of_range then
        raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
      end;
      v_observation := nullif(btrim(v_quote ->> 'observation'), '');
      if char_length(btrim(v_quote ->> 'modelOrAmperage')) not between 1 and 120
         or v_price <= 0 or (v_observation is not null and char_length(v_observation) > 500)
         or not exists (select 1 from api.parameter_values value where value.id = v_competitor_id
           and value.parameter_set_id = visit_row.parameter_set_id and value.category = 'competitor')
         or not exists (select 1 from api.parameter_values value where value.id = v_technology_id
           and value.parameter_set_id = visit_row.parameter_set_id and value.category = 'competitor_price_technology')
         or not exists (select 1 from api.parameter_values value where value.id = v_condition_id
           and value.parameter_set_id = visit_row.parameter_set_id and value.category = 'competitor_price_condition') then
        raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
      end if;
      insert into api.competitor_prices (
        report_id, parameter_set_id, competitor_id, model_or_amperage,
        technology_id, price_brl, condition_id, observation, ordinal
      ) values (
        v_report_id, visit_row.parameter_set_id, v_competitor_id,
        btrim(v_quote ->> 'modelOrAmperage'), v_technology_id, v_price,
        v_condition_id, v_observation, v_ordinal
      ) returning v_quotation_ids || jsonb_build_array(id) into v_quotation_ids;
    end loop;
  end if;

  v_result := jsonb_build_object(
    'schemaVersion', 1,
    'reportId', v_report_id,
    'visitId', visit_row.id,
    'offlineId', visit_row.offline_id,
    'availability', v_availability,
    'quotationIds', v_quotation_ids,
    'unavailableReasonId', v_reason_id,
    'serverSavedAt', v_server_saved_at
  );
  insert into private.competitor_price_receipts (event_id, visit_id, result_document)
  values (v_event_id, visit_row.id, v_result);

  insert into private.audit_events (
    actor_id, target_type, target_id, action, before_data, after_data, origin, occurred_at
  ) values (
    v_actor_id, 'visit_competitor_prices', visit_row.id, 'visit.prices.saved.v1', v_before,
    jsonb_build_object('reportId', v_report_id, 'availability', v_availability,
      'quotationCount', jsonb_array_length(v_quotation_ids), 'unavailableReasonId', v_reason_id),
    'system', v_server_saved_at
  );
  return v_result;
exception when invalid_text_representation or numeric_value_out_of_range
  or invalid_datetime_format or datetime_field_overflow then
  raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
end
$function$;

-- A visit started offline must bind to the catalog that was valid at the device
-- timestamp even if that catalog was retired before the event reached the server.
-- Patch the already-installed Story 3.1 function without rewriting its historical
-- migration; the rollback below restores the prior predicate byte-for-byte.
do $visit_start_ownership$
begin
  execute pg_catalog.format('grant cirne_visit_executor to %I with set true granted by current_user', current_user);
end
$visit_start_ownership$;
grant create on schema private to cirne_visit_executor;
set local role cirne_visit_executor;
do $upgrade_visit_start_catalog_resolution$
declare
  v_definition text := pg_catalog.pg_get_functiondef('private.apply_visit_started(uuid,jsonb)'::regprocedure);
  v_previous_predicate constant text := 'where parameter_row.status = ''published''';
  v_historical_predicate constant text := 'where parameter_row.status in (''published'', ''retired'')';
begin
  if pg_catalog.strpos(v_definition, v_previous_predicate) = 0 then
    raise exception 'Visit start catalog predicate does not match the expected prior definition';
  end if;
  execute pg_catalog.replace(v_definition, v_previous_predicate, v_historical_predicate);
end
$upgrade_visit_start_catalog_resolution$;
reset role;
revoke create on schema private from cirne_visit_executor;
do $visit_start_ownership$
begin
  execute pg_catalog.format('revoke cirne_visit_executor from %I granted by current_user', current_user);
end
$visit_start_ownership$;

do $sync_ownership$
begin
  execute pg_catalog.format('grant cirne_sync_executor to %I with set true granted by current_user', current_user);
end
$sync_ownership$;
grant create on schema private to cirne_sync_executor;
set local role cirne_sync_executor;

alter table private.sync_events drop constraint sync_events_operation_check;
alter table private.sync_events add constraint sync_events_operation_check
  check (operation in ('visit.draft.saved', 'visit.started.v1', 'visit.stock.saved.v1', 'visit.prices.saved.v1'));

alter function private.sync_event(uuid, jsonb) rename to sync_event_before_prices;

create function private.sync_event(p_device_id uuid, p_command jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_identity jsonb;
  v_delegated_result jsonb;
  v_start_result jsonb;
  v_actor_id uuid;
  v_event_id uuid;
  v_idempotency_key uuid;
  v_sequence integer;
  v_aggregate_id uuid;
  v_occurred_at timestamptz;
  v_payload jsonb;
  v_payload_hash text;
  v_previous private.sync_events%rowtype;
  v_previous_sequence integer;
  v_result jsonb;
  v_confirmation jsonb;
  v_confirmed_at timestamptz;
begin
  if p_command ->> 'operation' is distinct from 'visit.prices.saved.v1' then
    v_delegated_result := private.sync_event_before_prices(p_device_id, p_command);
    if p_command ->> 'operation' = 'visit.started.v1'
       and v_delegated_result ->> 'status' = 'confirmed' then
      v_start_result := private.get_visit_start_result(
        (v_delegated_result ->> 'canonicalId')::uuid
      );
      return v_delegated_result || jsonb_build_object(
        'parameterSetId', v_start_result -> 'parameterSetId'
      );
    end if;
    return v_delegated_result;
  end if;
  v_identity := private.resolve_current_identity();
  if v_identity is null
     or not (v_identity -> 'capabilities' @> '["sync.write_self"]'::jsonb)
     or not (v_identity -> 'roles' @> '["seller"]'::jsonb) then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;
  v_actor_id := (v_identity ->> 'id')::uuid;
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
     or p_command -> 'schemaVersion' is distinct from '1'::jsonb
     or v_sequence < 3 or p_command ->> 'aggregateType' is distinct from 'visit'
     or v_aggregate_id is null or v_occurred_at is null or jsonb_typeof(v_payload) <> 'object'
     or (v_payload ->> 'offlineId')::uuid <> v_aggregate_id then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  v_payload_hash := encode(extensions.digest(convert_to((jsonb_build_object(
    'operation', 'visit.prices.saved.v1', 'schemaVersion', 1, 'aggregateType', 'visit',
    'aggregateId', v_aggregate_id, 'sequence', v_sequence,
    'occurredAt', to_char(v_occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'payload', v_payload
  ))::text, 'UTF8'), 'sha256'), 'hex');

  perform pg_advisory_xact_lock(hashtextextended(
    v_actor_id::text || ':' || p_device_id::text || ':visit.prices.saved.v1:' || v_idempotency_key::text, 0
  ));
  select * into v_previous from private.sync_events stored
  where stored.actor_id = v_actor_id and stored.device_id = p_device_id
    and stored.operation = 'visit.prices.saved.v1' and stored.idempotency_key = v_idempotency_key;
  if found then
    if v_previous.payload_hash <> v_payload_hash then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    perform private.get_visit_competitor_prices_result(v_previous.event_id);
    return v_previous.canonical_result;
  end if;
  if exists (select 1 from private.sync_events stored where stored.actor_id = v_actor_id
    and stored.device_id = p_device_id and stored.event_id = v_event_id) then
    raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSED';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    v_actor_id::text || ':' || p_device_id::text || ':visit:' || v_aggregate_id::text, 1
  ));
  select max(stored.sequence) into v_previous_sequence from private.sync_events stored
  where stored.actor_id = v_actor_id and stored.device_id = p_device_id
    and stored.aggregate_type = 'visit' and stored.aggregate_id = v_aggregate_id;
  if v_previous_sequence is null or v_sequence <> v_previous_sequence + 1 then
    raise exception using errcode = 'P0001', message = 'EVENT_OUT_OF_ORDER';
  end if;

  v_result := private.apply_visit_competitor_prices_saved(p_device_id, p_command);
  v_confirmed_at := (v_result ->> 'serverSavedAt')::timestamptz;
  v_confirmation := jsonb_build_object(
    'eventId', v_event_id, 'status', 'confirmed', 'canonicalId', (v_result ->> 'visitId')::uuid,
    'confirmedAt', to_char(v_confirmed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
  insert into private.sync_events (
    actor_id, device_id, event_id, idempotency_key, operation, schema_version,
    sequence, payload_hash, aggregate_type, aggregate_id, status, attempt_count,
    canonical_result, occurred_at, confirmed_at
  ) values (
    v_actor_id, p_device_id, v_event_id, v_idempotency_key, 'visit.prices.saved.v1', 1,
    v_sequence, v_payload_hash, 'visit', v_aggregate_id, 'confirmed', 1,
    v_confirmation, v_occurred_at, v_confirmed_at
  );
  return v_confirmation;
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

create function private.save_visit_competitor_prices(
  p_device_id uuid,
  p_idempotency_key uuid,
  p_command jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_identity jsonb := private.resolve_current_identity();
  v_actor_id uuid := (v_identity ->> 'id')::uuid;
  v_offline_id uuid;
  v_event_id uuid;
  v_sequence integer;
  v_previous private.sync_events%rowtype;
begin
  if v_identity is null
     or not (v_identity -> 'capabilities' @> '["visit.start_self"]'::jsonb)
     or not (v_identity -> 'roles' @> '["seller"]'::jsonb) then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;
  if p_device_id is null or p_idempotency_key is null or jsonb_typeof(p_command) <> 'object'
     or p_command -> 'schemaVersion' is distinct from '1'::jsonb
     or not (p_command ?& array['schemaVersion', 'offlineId', 'availability', 'deviceSavedAt']) then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  begin
    v_offline_id := (p_command ->> 'offlineId')::uuid;
  exception when invalid_text_representation then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end;
  perform pg_advisory_xact_lock(hashtextextended(
    v_actor_id::text || ':' || p_device_id::text || ':visit.prices.saved.v1:' || p_idempotency_key::text, 0
  ));
  perform pg_advisory_xact_lock(hashtextextended(
    v_actor_id::text || ':' || p_device_id::text || ':visit:' || v_offline_id::text, 1
  ));
  select * into v_previous from private.sync_events stored
  where stored.actor_id = v_actor_id and stored.device_id = p_device_id
    and stored.operation = 'visit.prices.saved.v1' and stored.idempotency_key = p_idempotency_key;
  if found then
    v_event_id := v_previous.event_id;
    v_sequence := v_previous.sequence;
  else
    v_event_id := p_idempotency_key;
    select coalesce(max(stored.sequence), 0) + 1 into v_sequence
    from private.sync_events stored
    where stored.actor_id = v_actor_id and stored.device_id = p_device_id
      and stored.aggregate_type = 'visit' and stored.aggregate_id = v_offline_id;
  end if;
  perform private.sync_event(p_device_id, jsonb_build_object(
    'eventId', v_event_id, 'idempotencyKey', p_idempotency_key,
    'operation', 'visit.prices.saved.v1', 'schemaVersion', 1, 'sequence', v_sequence,
    'aggregateType', 'visit', 'aggregateId', v_offline_id,
    'occurredAt', p_command ->> 'deviceSavedAt', 'payload', p_command - 'schemaVersion'
  ));
  return private.get_visit_competitor_prices_result(v_event_id);
end
$function$;

create function api.save_visit_competitor_prices(
  p_device_id uuid,
  p_idempotency_key uuid,
  p_command jsonb
)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $function$
  select private.save_visit_competitor_prices(p_device_id, p_idempotency_key, p_command);
$function$;

create function api.get_current_competitor_price_parameters(p_at timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_identity jsonb := private.resolve_current_identity();
  v_set api.parameter_sets%rowtype;
  v_result jsonb;
begin
  if v_identity is null then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;
  if p_at is null then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  select * into v_set from api.parameter_sets candidate
  where candidate.status in ('published', 'retired') and candidate.valid_from <= p_at
  order by candidate.version desc limit 1;
  if not found then
    raise exception using errcode = 'P0001', message = 'DEPENDENCY_UNAVAILABLE';
  end if;
  select jsonb_build_object(
    'schemaVersion', 1,
    'parameterSetId', v_set.id,
    'version', v_set.version,
    'validFrom', v_set.valid_from,
    'values', jsonb_build_object(
      'competitors', coalesce(jsonb_agg(jsonb_build_object(
        'id', value.id, 'category', value.category, 'code', value.code,
        'label', value.label, 'sortOrder', value.sort_order
      ) order by value.sort_order, value.id) filter (where value.category = 'competitor'), '[]'::jsonb),
      'technologies', coalesce(jsonb_agg(jsonb_build_object(
        'id', value.id, 'category', value.category, 'code', value.code,
        'label', value.label, 'sortOrder', value.sort_order
      ) order by value.sort_order, value.id) filter (where value.category = 'competitor_price_technology'), '[]'::jsonb),
      'conditions', coalesce(jsonb_agg(jsonb_build_object(
        'id', value.id, 'category', value.category, 'code', value.code,
        'label', value.label, 'sortOrder', value.sort_order
      ) order by value.sort_order, value.id) filter (where value.category = 'competitor_price_condition'), '[]'::jsonb),
      'unavailableReasons', coalesce(jsonb_agg(jsonb_build_object(
        'id', value.id, 'category', value.category, 'code', value.code,
        'label', value.label, 'sortOrder', value.sort_order
      ) order by value.sort_order, value.id) filter (where value.category = 'competitor_price_unavailable_reason'), '[]'::jsonb)
    )
  ) into v_result
  from api.parameter_values value where value.parameter_set_id = v_set.id;
  return v_result;
end
$function$;

comment on table api.parameter_values is
  'Versioned parameter values. Story 3.3 intentionally adds no AB-02 operational seed.';
comment on table private.competitor_price_receipts is
  'Immutable per-event public result used to replay direct and offline saves exactly.';

do $ownership$
begin
  execute pg_catalog.format('grant cirne_visit_executor to %I with set true granted by current_user', current_user);
  execute pg_catalog.format('grant cirne_sync_executor to %I with set true granted by current_user', current_user);
end
$ownership$;
grant create on schema api, private to cirne_visit_executor;
grant create on schema private to cirne_sync_executor;
alter table api.parameter_values owner to cirne_visit_executor;
alter table api.competitor_price_reports owner to cirne_visit_executor;
alter table api.competitor_prices owner to cirne_visit_executor;
alter table private.competitor_price_receipts owner to cirne_visit_executor;
alter function private.guard_published_parameter_values() owner to cirne_visit_executor;
alter function private.get_visit_competitor_prices_result(uuid) owner to cirne_visit_executor;
alter function private.apply_visit_competitor_prices_saved(uuid, jsonb) owner to cirne_visit_executor;
alter function private.save_visit_competitor_prices(uuid, uuid, jsonb) owner to cirne_sync_executor;
alter function api.save_visit_competitor_prices(uuid, uuid, jsonb) owner to cirne_visit_executor;
alter function api.get_current_competitor_price_parameters(timestamptz) owner to cirne_visit_executor;
revoke create on schema api, private from cirne_visit_executor;
revoke create on schema private from cirne_sync_executor;

set local role cirne_visit_executor;
revoke all on function private.guard_published_parameter_values(),
  private.get_visit_competitor_prices_result(uuid),
  private.apply_visit_competitor_prices_saved(uuid, jsonb) from public, anon, authenticated;
revoke all on function api.save_visit_competitor_prices(uuid, uuid, jsonb) from public, anon;
grant execute on function api.save_visit_competitor_prices(uuid, uuid, jsonb) to authenticated;
revoke all on function api.get_current_competitor_price_parameters(timestamptz) from public, anon;
grant execute on function api.get_current_competitor_price_parameters(timestamptz) to authenticated;
grant execute on function private.get_visit_competitor_prices_result(uuid),
  private.apply_visit_competitor_prices_saved(uuid, jsonb) to cirne_sync_executor;
reset role;

set local role cirne_sync_executor;
revoke all on function private.save_visit_competitor_prices(uuid, uuid, jsonb),
  private.sync_event(uuid, jsonb) from public, anon, authenticated;
grant execute on function private.save_visit_competitor_prices(uuid, uuid, jsonb),
  private.sync_event(uuid, jsonb) to cirne_visit_executor;
reset role;

do $ownership$
begin
  execute pg_catalog.format('revoke cirne_visit_executor from %I granted by current_user', current_user);
  execute pg_catalog.format('revoke cirne_sync_executor from %I granted by current_user', current_user);
end
$ownership$;

commit;
