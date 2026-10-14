-- Story 3.9: own commercial action catalog and visit commercial-action collection.
begin;
select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cirne:database:migrate'));
set local lock_timeout = '5s';

create table api.commercial_actions (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(btrim(title)) between 1 and 120),
  description text not null check (char_length(btrim(description)) between 1 and 1200),
  valid_from date not null,
  valid_until date not null,
  banner_url text check (banner_url is null or char_length(banner_url) between 1 and 1000),
  active boolean not null default true,
  created_by uuid not null references api.user_profiles(id) on delete restrict,
  updated_by uuid not null references api.user_profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (valid_until >= valid_from)
);

do $visit_ownership$
begin
  execute pg_catalog.format('grant cirne_visit_executor to %I with set true granted by current_user', current_user);
end
$visit_ownership$;
grant create on schema api to cirne_visit_executor;
set local role cirne_visit_executor;
do $reference_grant$
begin
  execute pg_catalog.format('grant references on table api.visits to %I', session_user);
end
$reference_grant$;
alter table api.visit_attachments drop constraint visit_attachments_purpose_check;
alter table api.visit_attachments add constraint visit_attachments_purpose_check check (
  purpose in ('visit_checkin', 'visit_checkout', 'commercial_action_evidence')
);
create or replace function api.reserve_visit_attachment(
  p_device_id uuid, p_idempotency_key uuid, p_command jsonb
)
returns jsonb language plpgsql volatile security definer set search_path = '' as $function$
declare
  actor_id uuid := private.visit_attachment_identity();
  visit_row api.visits%rowtype;
  existing api.visit_attachments%rowtype;
  v_offline_id uuid; v_visit_offline_id uuid; v_purpose text; v_content_type text;
  v_byte_size integer; v_checksum text; v_captured_at timestamptz; v_expires_at timestamptz;
  v_hash text; v_id uuid := gen_random_uuid(); v_path text;
begin
  if p_device_id is null or p_idempotency_key is null or p_command -> 'schemaVersion' <> '1'::jsonb then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  begin
    v_offline_id := (p_command ->> 'offlineId')::uuid;
    v_visit_offline_id := (p_command ->> 'visitOfflineId')::uuid;
    v_purpose := p_command ->> 'purpose'; v_content_type := p_command ->> 'contentType';
    v_byte_size := (p_command ->> 'byteSize')::integer; v_checksum := p_command ->> 'checksum';
    v_captured_at := (p_command ->> 'capturedAt')::timestamptz;
    v_expires_at := (p_command ->> 'expiresAt')::timestamptz;
  exception when others then raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED'; end;
  if v_purpose not in ('visit_checkin','visit_checkout','commercial_action_evidence')
     or v_content_type not in ('image/jpeg','image/webp')
     or v_byte_size not between 1 and 2097152 or v_checksum !~ '^[0-9a-f]{64}$'
     or v_expires_at < v_captured_at + interval '179 days'
     or v_expires_at > v_captured_at + interval '181 days' then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  select * into visit_row from api.visits visit
  where visit.seller_id = actor_id and visit.device_id = p_device_id
    and visit.offline_id = v_visit_offline_id;
  if not found then raise exception using errcode = 'P0001', message = 'FORBIDDEN'; end if;
  v_hash := encode(extensions.digest(convert_to(p_command::text, 'UTF8'), 'sha256'), 'hex');
  select * into existing from api.visit_attachments attachment
  where attachment.seller_id = actor_id and attachment.device_id = p_device_id
    and (attachment.offline_id = v_offline_id or attachment.reservation_key = p_idempotency_key)
  for update;
  if found then
    if existing.offline_id <> v_offline_id or existing.reservation_hash <> v_hash then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return jsonb_build_object('attachmentId', existing.id, 'offlineId', existing.offline_id,
      'storagePath', existing.storage_path, 'status', existing.status,
      'verifiedAt', existing.verified_at);
  end if;
  v_path := 'seller/' || actor_id || '/visit/' || visit_row.id || '/' || v_id ||
    case when v_content_type = 'image/webp' then '.webp' else '.jpg' end;
  insert into api.visit_attachments (id, offline_id, visit_id, seller_id, device_id, purpose,
    storage_path, content_type, byte_size, checksum, captured_at, expires_at, status,
    reservation_key, reservation_hash)
  values (v_id, v_offline_id, visit_row.id, actor_id, p_device_id, v_purpose, v_path,
    v_content_type, v_byte_size, v_checksum, v_captured_at, v_expires_at, 'reserved',
    p_idempotency_key, v_hash) returning * into existing;
  return jsonb_build_object('attachmentId', existing.id, 'offlineId', existing.offline_id,
    'storagePath', existing.storage_path, 'status', existing.status,
    'verifiedAt', existing.verified_at);
end
$function$;
reset role;
revoke create on schema api from cirne_visit_executor;
do $visit_ownership$
begin
  execute pg_catalog.format('revoke cirne_visit_executor from %I granted by current_user', current_user);
end
$visit_ownership$;

create table api.visit_commercial_action_reports (
  id uuid primary key default gen_random_uuid(),
  visit_id uuid not null unique references api.visits(id) on delete restrict,
  competitor_availability text not null check (competitor_availability in ('identified', 'not_identified')),
  last_event_id uuid not null,
  device_saved_at timestamptz not null,
  server_saved_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table api.visit_own_action_acknowledgements (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references api.visit_commercial_action_reports(id) on delete cascade,
  commercial_action_id uuid not null references api.commercial_actions(id) on delete restrict,
  title_snapshot text not null,
  valid_from_snapshot date not null,
  valid_until_snapshot date not null,
  presented boolean not null check (presented),
  ordinal integer not null check (ordinal between 1 and 50),
  unique (report_id, commercial_action_id),
  unique (report_id, ordinal)
);

create table api.visit_competitor_commercial_actions (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references api.visit_commercial_action_reports(id) on delete cascade,
  offline_id uuid not null,
  competitor_id uuid not null,
  action_type text not null check (action_type in (
    'differentiated_price', 'seller_or_driver_incentive', 'retailer_incentive', 'purchase_combo', 'other'
  )),
  other_type text,
  description text not null check (char_length(btrim(description)) between 1 and 1200),
  valid_from date not null,
  valid_until date not null,
  evidence_attachment_offline_id uuid,
  ordinal integer not null check (ordinal between 1 and 10),
  created_at timestamptz not null default now(),
  check (valid_until >= valid_from),
  check ((action_type = 'other' and char_length(btrim(other_type)) between 1 and 120)
    or (action_type <> 'other' and other_type is null)),
  unique (report_id, offline_id),
  unique (report_id, ordinal)
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

create trigger commercial_actions_set_updated_at before update on api.commercial_actions
for each row execute function private.set_updated_at();
create trigger visit_commercial_action_reports_set_updated_at before update on api.visit_commercial_action_reports
for each row execute function private.set_updated_at();

alter table api.commercial_actions enable row level security;
alter table api.commercial_actions force row level security;
alter table api.visit_commercial_action_reports enable row level security;
alter table api.visit_commercial_action_reports force row level security;
alter table api.visit_own_action_acknowledgements enable row level security;
alter table api.visit_own_action_acknowledgements force row level security;
alter table api.visit_competitor_commercial_actions enable row level security;
alter table api.visit_competitor_commercial_actions force row level security;

do $identity_ownership$
begin
  execute pg_catalog.format('grant cirne_identity_executor to %I with set true granted by current_user', current_user);
end
$identity_ownership$;
grant create on schema private to cirne_identity_executor;
set local role cirne_identity_executor;
create function private.commercial_actions_access(p_manage boolean default false)
returns boolean language plpgsql stable security definer set search_path = '' as $function$
declare identity_document jsonb := private.resolve_current_identity();
begin
  if identity_document is null then return false; end if;
  if not p_manage then return true; end if;
  return identity_document -> 'roles' @> '["manager"]'::jsonb
    and identity_document -> 'capabilities' @> '["route.plan_scoped"]'::jsonb;
end
$function$;
revoke all on function private.commercial_actions_access(boolean) from public, anon;
grant execute on function private.commercial_actions_access(boolean) to authenticated;
reset role;
revoke create on schema private from cirne_identity_executor;
do $identity_ownership$
begin
  execute pg_catalog.format('revoke cirne_identity_executor from %I granted by current_user', current_user);
end
$identity_ownership$;

create policy commercial_actions_read on api.commercial_actions for select to authenticated
using (private.commercial_actions_access(false));
create policy commercial_actions_manage on api.commercial_actions for all to authenticated
using (private.commercial_actions_access(true))
with check (private.commercial_actions_access(true));
create policy commercial_actions_sync_read on api.commercial_actions for select to cirne_sync_executor
using (true);
do $existing_policy_ownership$
begin
  execute pg_catalog.format('grant cirne_visit_executor to %I with set true granted by current_user', current_user);
end
$existing_policy_ownership$;
set local role cirne_visit_executor;
create policy visits_commercial_actions_sync_read on api.visits for select to cirne_sync_executor using (true);
create policy competitor_price_reports_commercial_actions_sync_read on api.competitor_price_reports
for select to cirne_sync_executor using (true);
create policy parameter_values_commercial_actions_sync_read on api.parameter_values
for select to cirne_sync_executor using (true);
create policy visit_attachments_commercial_actions_sync_read on api.visit_attachments
for select to cirne_sync_executor using (true);
grant select on api.visits, api.competitor_price_reports, api.parameter_values,
  api.visit_attachments to cirne_sync_executor;
reset role;
do $existing_policy_ownership$
begin
  execute pg_catalog.format('revoke cirne_visit_executor from %I granted by current_user', current_user);
end
$existing_policy_ownership$;
create policy visit_commercial_reports_executor on api.visit_commercial_action_reports
for all to cirne_visit_executor using (true) with check (true);
create policy visit_own_actions_executor on api.visit_own_action_acknowledgements
for all to cirne_visit_executor using (true) with check (true);
create policy visit_competitor_actions_executor on api.visit_competitor_commercial_actions
for all to cirne_visit_executor using (true) with check (true);
create policy visit_commercial_reports_sync_executor on api.visit_commercial_action_reports
for all to cirne_sync_executor using (true) with check (true);
create policy visit_own_actions_sync_executor on api.visit_own_action_acknowledgements
for all to cirne_sync_executor using (true) with check (true);
create policy visit_competitor_actions_sync_executor on api.visit_competitor_commercial_actions
for all to cirne_sync_executor using (true) with check (true);

revoke all on api.commercial_actions, api.visit_commercial_action_reports,
  api.visit_own_action_acknowledgements, api.visit_competitor_commercial_actions from public, anon;
grant select, insert, update on api.commercial_actions to authenticated;
grant select, insert, update, delete on api.commercial_actions to service_role;
grant select, insert, update, delete on api.visit_commercial_action_reports,
  api.visit_own_action_acknowledgements, api.visit_competitor_commercial_actions to cirne_visit_executor;
grant select on api.commercial_actions to cirne_sync_executor;
grant select, insert, update, delete on api.visit_commercial_action_reports,
  api.visit_own_action_acknowledgements, api.visit_competitor_commercial_actions to cirne_sync_executor;

do $completion_ownership$
begin
  execute pg_catalog.format('grant cirne_visit_executor to %I with set true granted by current_user', current_user);
end
$completion_ownership$;
grant create on schema private to cirne_visit_executor;
set local role cirne_visit_executor;
create function private.require_commercial_actions_before_completion()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  if new.status = 'completed' and old.status <> 'completed'
     and not exists (
       select 1 from api.visit_commercial_action_reports report where report.visit_id = new.id
     ) then
    raise exception using errcode = 'P0001', message = 'EVENT_OUT_OF_ORDER';
  end if;
  return new;
end
$function$;
create trigger visits_require_commercial_actions_before_completion
before update of status on api.visits for each row
execute function private.require_commercial_actions_before_completion();
revoke all on function private.require_commercial_actions_before_completion() from public, anon, authenticated;
reset role;
revoke create on schema private from cirne_visit_executor;
do $completion_ownership$
begin
  execute pg_catalog.format('revoke cirne_visit_executor from %I granted by current_user', current_user);
end
$completion_ownership$;

do $sync_ownership$
begin
  execute pg_catalog.format('grant cirne_sync_executor to %I with set true granted by current_user', current_user);
end
$sync_ownership$;
grant create on schema private to cirne_sync_executor;
set local role cirne_sync_executor;

alter table private.sync_events drop constraint sync_events_operation_check;
alter table private.sync_events add constraint sync_events_operation_check check (operation in (
  'visit.draft.saved', 'visit.started.v1', 'visit.stock.saved.v1', 'visit.prices.saved.v1',
  'visit.commercial-actions.saved.v1'
));
alter function private.sync_event(uuid, jsonb) rename to sync_event_before_commercial_actions;

create function private.sync_event(p_device_id uuid, p_command jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $function$
declare
  v_identity_document jsonb;
  v_actor_id uuid;
  v_event_id uuid;
  v_idempotency_key uuid;
  v_aggregate_id uuid;
  v_event_sequence integer;
  v_occurred_at timestamptz;
  v_payload jsonb;
  v_payload_hash text;
  v_previous private.sync_events%rowtype;
  v_previous_sequence integer;
  v_visit_row api.visits%rowtype;
  v_report_id uuid;
  v_availability text;
  v_item jsonb;
  v_action api.commercial_actions%rowtype;
  v_competitor_id uuid;
  v_attachment_offline_id uuid;
  v_visit_date date;
  v_ordinal integer;
  v_confirmed_at timestamptz := clock_timestamp();
  v_confirmation jsonb;
begin
  if p_command ->> 'operation' is distinct from 'visit.commercial-actions.saved.v1' then
    return private.sync_event_before_commercial_actions(p_device_id, p_command);
  end if;
  v_identity_document := private.resolve_current_identity();
  if v_identity_document is null or not (v_identity_document -> 'roles' @> '["seller"]'::jsonb)
    or not (v_identity_document -> 'capabilities' @> '["sync.write_self"]'::jsonb) then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;
  v_actor_id := (v_identity_document ->> 'id')::uuid;
  begin
    v_event_id := (p_command ->> 'eventId')::uuid;
    v_idempotency_key := (p_command ->> 'idempotencyKey')::uuid;
    v_aggregate_id := (p_command ->> 'aggregateId')::uuid;
    v_event_sequence := (p_command ->> 'sequence')::integer;
    v_occurred_at := (p_command ->> 'occurredAt')::timestamptz;
    v_payload := p_command -> 'payload';
  exception when others then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end;
  if v_event_sequence < 4 or p_command ->> 'aggregateType' <> 'visit'
    or v_payload ->> 'offlineId' <> v_aggregate_id::text
    or jsonb_typeof(v_payload -> 'ownAcknowledgements') <> 'array'
    or jsonb_typeof(v_payload -> 'competitor') <> 'object' then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  v_payload_hash := encode(extensions.digest(convert_to(p_command::text, 'UTF8'), 'sha256'), 'hex');
  perform pg_advisory_xact_lock(hashtextextended(v_actor_id::text || ':' || p_device_id::text || ':visit:' || v_aggregate_id::text, 1));
  select * into v_previous from private.sync_events stored
  where stored.actor_id = v_actor_id and stored.device_id = p_device_id
    and stored.operation = 'visit.commercial-actions.saved.v1' and stored.idempotency_key = v_idempotency_key;
  if found then
    if v_previous.payload_hash <> v_payload_hash then raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSED'; end if;
    return v_previous.canonical_result;
  end if;
  select max(stored.sequence) into v_previous_sequence from private.sync_events stored
  where stored.actor_id = v_actor_id and stored.device_id = p_device_id
    and stored.aggregate_type = 'visit' and stored.aggregate_id = v_aggregate_id;
  if v_previous_sequence is null or v_event_sequence <> v_previous_sequence + 1 then
    raise exception using errcode = 'P0001', message = 'EVENT_OUT_OF_ORDER';
  end if;
  select * into v_visit_row from api.visits visit
  where visit.offline_id = v_aggregate_id and visit.device_id = p_device_id and visit.seller_id = v_actor_id;
  if not found then raise exception using errcode = 'P0001', message = 'NOT_FOUND'; end if;
  if v_visit_row.status <> 'in_progress'
    or not exists (select 1 from api.competitor_price_reports price where price.visit_id = v_visit_row.id) then
    raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT';
  end if;
  v_visit_date := (v_occurred_at at time zone 'America/Sao_Paulo')::date;
  v_availability := v_payload -> 'competitor' ->> 'availability';
  if v_availability not in ('identified', 'not_identified') then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  delete from api.visit_commercial_action_reports report where report.visit_id = v_visit_row.id;
  insert into api.visit_commercial_action_reports (visit_id, competitor_availability, last_event_id, device_saved_at, server_saved_at)
  values (v_visit_row.id, v_availability, v_event_id, (v_payload ->> 'deviceSavedAt')::timestamptz, v_confirmed_at)
  returning id into v_report_id;
  v_ordinal := 0;
  for v_item in select value from jsonb_array_elements(v_payload -> 'ownAcknowledgements') loop
    v_ordinal := v_ordinal + 1;
    if v_item -> 'presented' is distinct from 'true'::jsonb then raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED'; end if;
    select * into v_action from api.commercial_actions action
    where action.id = (v_item ->> 'actionId')::uuid and action.active
      and v_visit_date between action.valid_from and action.valid_until;
    if not found then raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED'; end if;
    insert into api.visit_own_action_acknowledgements
      (report_id, commercial_action_id, title_snapshot, valid_from_snapshot, valid_until_snapshot, presented, ordinal)
    values (v_report_id, v_action.id, v_action.title, v_action.valid_from,
      v_action.valid_until, true, v_ordinal);
  end loop;
  if v_availability = 'identified' then
    if jsonb_array_length(v_payload -> 'competitor' -> 'actions') < 1 then raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED'; end if;
    v_ordinal := 0;
    for v_item in select value from jsonb_array_elements(v_payload -> 'competitor' -> 'actions') loop
      v_ordinal := v_ordinal + 1;
      v_competitor_id := (v_item ->> 'competitorId')::uuid;
      v_attachment_offline_id := nullif(v_item ->> 'evidenceAttachmentOfflineId', '')::uuid;
      if not exists (
        select 1 from api.parameter_values parameter
        where parameter.id = v_competitor_id
          and parameter.parameter_set_id = v_visit_row.parameter_set_id
          and parameter.category = 'competitor'
      ) then
        raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
      end if;
      if v_attachment_offline_id is not null and not exists (
        select 1 from api.visit_attachments attachment
        where attachment.visit_id = v_visit_row.id
          and attachment.seller_id = v_actor_id
          and attachment.device_id = p_device_id
          and attachment.offline_id = v_attachment_offline_id
          and attachment.purpose = 'commercial_action_evidence'
          and attachment.status = 'verified'
      ) then
        raise exception using errcode = 'P0001', message = 'ATTACHMENT_NOT_VERIFIED';
      end if;
      insert into api.visit_competitor_commercial_actions
        (report_id, offline_id, competitor_id, action_type, other_type, description,
         valid_from, valid_until, evidence_attachment_offline_id, ordinal)
      values (v_report_id, (v_item ->> 'offlineId')::uuid, v_competitor_id,
        v_item ->> 'actionType', nullif(v_item ->> 'otherType', ''), v_item ->> 'description',
        (v_item ->> 'validFrom')::date, (v_item ->> 'validUntil')::date,
        v_attachment_offline_id, v_ordinal);
    end loop;
  end if;
  v_confirmation := jsonb_build_object('eventId', v_event_id, 'status', 'confirmed',
    'canonicalId', v_visit_row.id, 'confirmedAt', v_confirmed_at);
  insert into private.sync_events (actor_id, device_id, event_id, idempotency_key, operation,
    schema_version, sequence, payload_hash, aggregate_type, aggregate_id, status, attempt_count,
    canonical_result, occurred_at, confirmed_at)
  values (v_actor_id, p_device_id, v_event_id, v_idempotency_key, 'visit.commercial-actions.saved.v1',
    1, v_event_sequence, v_payload_hash, 'visit', v_aggregate_id, 'confirmed', 1,
    v_confirmation, v_occurred_at, v_confirmed_at);
  return v_confirmation;
exception when invalid_text_representation or invalid_datetime_format or check_violation
  or foreign_key_violation or not_null_violation then
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

do $sync_acl_ownership$
begin
  execute pg_catalog.format('grant cirne_sync_executor to %I with set true granted by current_user', current_user);
end
$sync_acl_ownership$;
set local role cirne_sync_executor;
revoke all on function private.sync_event(uuid, jsonb) from public, anon, authenticated;
grant execute on function private.sync_event(uuid, jsonb) to cirne_visit_executor;
reset role;
do $sync_acl_ownership$
begin
  execute pg_catalog.format('revoke cirne_sync_executor from %I granted by current_user', current_user);
end
$sync_acl_ownership$;

commit;
