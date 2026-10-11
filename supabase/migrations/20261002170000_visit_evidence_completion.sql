begin;

do $ownership$
begin
  execute pg_catalog.format('grant cirne_visit_executor to %I with set true granted by current_user', current_user);
end
$ownership$;
grant create on schema api, private to cirne_visit_executor;
set local role cirne_visit_executor;

alter table api.visits drop constraint visits_status_check;
alter table api.visits add constraint visits_status_check check (status in ('in_progress', 'completed'));
alter table api.visits add column device_completed_at timestamptz;
alter table api.visits add column server_completed_at timestamptz;
alter table api.visits add column completion_payload_hash text check (
  completion_payload_hash is null or completion_payload_hash ~ '^[0-9a-f]{64}$'
);
alter table api.visits add constraint visits_completion_shape_check check (
  (status = 'in_progress' and device_completed_at is null and server_completed_at is null and completion_payload_hash is null)
  or (status = 'completed' and device_completed_at is not null and server_completed_at is not null and completion_payload_hash is not null)
);
alter table api.visits add constraint visits_id_seller_key unique (id, seller_id);

alter table api.location_events drop constraint location_events_kind_check;
alter table api.location_events drop constraint location_events_measurements_check;
alter table api.location_events alter column position drop not null;
alter table api.location_events add column issues text[] not null default '{}';
alter table api.location_events add constraint location_events_kind_check check (kind in ('start', 'completion'));
alter table api.location_events add constraint location_events_measurements_check check (
  (accuracy_m is null or accuracy_m >= 0) and (distance_m is null or distance_m >= 0)
  and issues <@ array['camera_unavailable','gps_unavailable','gps_low_accuracy','outside_radius','client_location_missing']::text[]
  and cardinality(issues) <= 5
  and ((cardinality(issues) = 0 and exception_reason is null) or
       (cardinality(issues) > 0 and length(trim(exception_reason)) between 10 and 500))
);

create table api.visit_attachments (
  id uuid primary key default gen_random_uuid(),
  offline_id uuid not null,
  visit_id uuid not null,
  seller_id uuid not null,
  device_id uuid not null,
  purpose text not null check (purpose in ('visit_checkin', 'visit_checkout')),
  storage_path text not null unique check (storage_path ~ '^seller/[0-9a-f-]{36}/visit/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|webp)$'),
  content_type text not null check (content_type in ('image/jpeg', 'image/webp')),
  byte_size integer not null check (byte_size between 1 and 2097152),
  checksum text not null check (checksum ~ '^[0-9a-f]{64}$'),
  captured_at timestamptz not null,
  expires_at timestamptz not null,
  status text not null check (status in ('reserved', 'verified')),
  reservation_key uuid not null,
  reservation_hash text not null check (reservation_hash ~ '^[0-9a-f]{64}$'),
  confirmation_key uuid,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint visit_attachments_offline_key unique (seller_id, device_id, offline_id),
  constraint visit_attachments_reservation_key unique (seller_id, device_id, reservation_key),
  constraint visit_attachments_visit_seller_fkey foreign key (visit_id, seller_id)
    references api.visits(id, seller_id) on delete restrict,
  constraint visit_attachments_retention_check check (
    expires_at >= captured_at + interval '179 days' and expires_at <= captured_at + interval '181 days'
  ),
  constraint visit_attachments_verified_shape_check check (
    (status = 'reserved' and confirmation_key is null and verified_at is null)
    or (status = 'verified' and confirmation_key is not null and verified_at is not null)
  )
);
alter table api.location_events add column attachment_id uuid references api.visit_attachments(id) on delete restrict;
alter table api.location_events add column evidence_payload_hash text check (
  evidence_payload_hash is null or evidence_payload_hash ~ '^[0-9a-f]{64}$'
);
create trigger visit_attachments_set_updated_at before update on api.visit_attachments
for each row execute function private.set_updated_at();
create index visit_attachments_expiry_idx on api.visit_attachments (expires_at) where status = 'verified';

alter table api.visit_attachments enable row level security;
alter table api.visit_attachments force row level security;
create policy visit_attachments_executor_all on api.visit_attachments
  for all to cirne_visit_executor using (true) with check (true);
revoke all on table api.visit_attachments from public, anon, authenticated;
grant select, insert, update, delete on table api.visit_attachments to cirne_visit_executor;

reset role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('visit-evidence', 'visit-evidence', false, 2097152, array['image/jpeg', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = 2097152,
  allowed_mime_types = excluded.allowed_mime_types;

set local role cirne_visit_executor;

create function private.visit_attachment_identity()
returns uuid language plpgsql stable security definer set search_path = '' as $function$
declare identity_document jsonb;
begin
  identity_document := private.resolve_current_identity();
  if identity_document is null or not (identity_document -> 'capabilities' @> '["visit.start_self"]'::jsonb) then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;
  return (identity_document ->> 'id')::uuid;
end
$function$;

create function private.can_access_visit_attachment(p_path text)
returns boolean language sql stable security definer set search_path = '' as $function$
  select exists (
    select 1 from api.visit_attachments attachment
    where attachment.storage_path = p_path and attachment.seller_id = private.visit_attachment_identity()
      and attachment.expires_at > clock_timestamp()
  );
$function$;

reset role;

create policy visit_evidence_insert_self on storage.objects for insert to authenticated
with check (bucket_id = 'visit-evidence' and private.can_access_visit_attachment(name));
create policy visit_evidence_select_self on storage.objects for select to authenticated
using (bucket_id = 'visit-evidence' and private.can_access_visit_attachment(name));

set local role cirne_visit_executor;

create function api.reserve_visit_attachment(p_device_id uuid, p_idempotency_key uuid, p_command jsonb)
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
  if v_purpose not in ('visit_checkin','visit_checkout') or v_content_type not in ('image/jpeg','image/webp')
     or v_byte_size not between 1 and 2097152 or v_checksum !~ '^[0-9a-f]{64}$'
     or v_expires_at < v_captured_at + interval '179 days' or v_expires_at > v_captured_at + interval '181 days' then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  select * into visit_row from api.visits visit
  where visit.seller_id = actor_id and visit.device_id = p_device_id and visit.offline_id = v_visit_offline_id;
  if not found then raise exception using errcode = 'P0001', message = 'FORBIDDEN'; end if;
  v_hash := encode(extensions.digest(convert_to(p_command::text, 'UTF8'), 'sha256'), 'hex');
  select * into existing from api.visit_attachments attachment
  where attachment.seller_id = actor_id and attachment.device_id = p_device_id
    and (attachment.offline_id = v_offline_id or attachment.reservation_key = p_idempotency_key) for update;
  if found then
    if existing.offline_id <> v_offline_id or existing.reservation_hash <> v_hash then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return jsonb_build_object('attachmentId', existing.id, 'offlineId', existing.offline_id,
      'storagePath', existing.storage_path, 'status', existing.status, 'verifiedAt', existing.verified_at);
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
    'storagePath', existing.storage_path, 'status', existing.status, 'verifiedAt', existing.verified_at);
end
$function$;

create function api.get_visit_attachment_for_confirmation(p_device_id uuid, p_offline_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $function$
declare actor_id uuid := private.visit_attachment_identity(); attachment api.visit_attachments%rowtype;
begin
  select * into attachment from api.visit_attachments item where item.seller_id = actor_id
    and item.device_id = p_device_id and item.offline_id = p_offline_id;
  if not found then raise exception using errcode = 'P0001', message = 'FORBIDDEN'; end if;
  return jsonb_build_object('storagePath', attachment.storage_path, 'contentType', attachment.content_type,
    'byteSize', attachment.byte_size, 'checksum', attachment.checksum);
end
$function$;

create function api.confirm_visit_attachment(p_device_id uuid, p_idempotency_key uuid,
  p_offline_id uuid, p_checksum text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $function$
declare actor_id uuid := private.visit_attachment_identity(); attachment api.visit_attachments%rowtype; verified timestamptz;
begin
  select * into attachment from api.visit_attachments item where item.seller_id = actor_id
    and item.device_id = p_device_id and item.offline_id = p_offline_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'FORBIDDEN'; end if;
  if attachment.checksum <> p_checksum then raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED'; end if;
  if attachment.status = 'verified' then
    if attachment.confirmation_key <> p_idempotency_key then raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSED'; end if;
    verified := attachment.verified_at;
  else
    verified := clock_timestamp();
    update api.visit_attachments set status = 'verified', confirmation_key = p_idempotency_key,
      verified_at = verified where id = attachment.id;
  end if;
  return jsonb_build_object('schemaVersion', 1, 'attachmentId', attachment.id,
    'offlineId', attachment.offline_id, 'status', 'verified', 'verifiedAt', verified);
end
$function$;

create function api.save_visit_checkin_evidence(p_device_id uuid, p_idempotency_key uuid, p_command jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $function$
declare
  actor_id uuid := private.visit_attachment_identity(); visit_row api.visits%rowtype;
  event_row api.location_events%rowtype; evidence jsonb; location_document jsonb;
  v_offline_id uuid; v_evidence_id uuid; v_attachment_offline_id uuid; v_attachment_id uuid;
  v_captured_at timestamptz; v_latitude numeric; v_longitude numeric; v_accuracy numeric; v_distance numeric;
  v_issues text[]; v_justification text; v_hash text; v_saved_at timestamptz := clock_timestamp();
begin
  if p_device_id is null or p_idempotency_key is null or p_command -> 'schemaVersion' <> '1'::jsonb then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  begin
    v_offline_id := (p_command ->> 'offlineId')::uuid; evidence := p_command -> 'evidence';
    v_evidence_id := (evidence ->> 'offlineId')::uuid; v_captured_at := (evidence ->> 'capturedAt')::timestamptz;
    v_attachment_offline_id := nullif(evidence ->> 'attachmentOfflineId','')::uuid;
    location_document := evidence -> 'location';
    v_latitude := nullif(location_document ->> 'latitude','')::numeric;
    v_longitude := nullif(location_document ->> 'longitude','')::numeric;
    v_accuracy := nullif(location_document ->> 'accuracyM','')::numeric;
    v_distance := nullif(location_document ->> 'distanceM','')::numeric;
    select coalesce(array_agg(value), '{}') into v_issues from jsonb_array_elements_text(evidence -> 'issues') value;
    v_justification := nullif(trim(evidence ->> 'justification'), '');
  exception when others then raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED'; end;
  if (v_latitude is null) <> (v_longitude is null) or abs(coalesce(v_latitude,0)) > 90
     or abs(coalesce(v_longitude,0)) > 180 or cardinality(v_issues) > 5
     or (cardinality(v_issues) > 0 and (v_justification is null or length(v_justification) < 10))
     or (v_attachment_offline_id is null and not ('camera_unavailable' = any(v_issues))) then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  select * into visit_row from api.visits visit where visit.seller_id=actor_id
    and visit.device_id=p_device_id and visit.offline_id=v_offline_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'FORBIDDEN'; end if;
  if v_attachment_offline_id is not null then
    select attachment.id into v_attachment_id from api.visit_attachments attachment
    where attachment.visit_id=visit_row.id and attachment.offline_id=v_attachment_offline_id
      and attachment.purpose='visit_checkin' and attachment.status='verified';
    if not found then raise exception using errcode = 'P0001', message = 'EVENT_OUT_OF_ORDER'; end if;
  end if;
  v_hash := encode(extensions.digest(convert_to(p_command::text, 'UTF8'), 'sha256'), 'hex');
  select * into event_row from api.location_events event
    where event.visit_id=visit_row.id and event.kind='start' for update;
  if found and event_row.evidence_payload_hash is not null then
    if event_row.evidence_payload_hash <> v_hash then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return jsonb_build_object('schemaVersion',1,'visitId',visit_row.id,'offlineId',visit_row.offline_id,
      'kind','checkin','serverSavedAt',event_row.server_received_at);
  end if;
  if found then
    update api.location_events set device_captured_at=v_captured_at, server_received_at=v_saved_at,
      position=case when v_latitude is null then null else extensions.st_setsrid(
        extensions.st_makepoint(v_longitude,v_latitude),4326)::extensions.geography end,
      accuracy_m=v_accuracy, distance_m=v_distance, exception_reason=v_justification,
      issues=v_issues, attachment_id=v_attachment_id, evidence_payload_hash=v_hash
    where id=event_row.id;
  else
    insert into api.location_events (id,visit_id,kind,device_captured_at,server_received_at,position,
      accuracy_m,distance_m,exception_reason,issues,attachment_id,evidence_payload_hash)
    values (v_evidence_id,visit_row.id,'start',v_captured_at,v_saved_at,
      case when v_latitude is null then null else extensions.st_setsrid(
        extensions.st_makepoint(v_longitude,v_latitude),4326)::extensions.geography end,
      v_accuracy,v_distance,v_justification,v_issues,v_attachment_id,v_hash);
  end if;
  insert into private.audit_events (actor_id,target_type,target_id,action,after_data,origin,occurred_at)
  values (actor_id,'visit',visit_row.id,'visit.checkin_evidence.saved.v1',jsonb_build_object(
    'evidenceOfflineId',v_evidence_id,'hasPhoto',v_attachment_id is not null,'issues',v_issues),'system',v_saved_at);
  return jsonb_build_object('schemaVersion',1,'visitId',visit_row.id,'offlineId',visit_row.offline_id,
    'kind','checkin','serverSavedAt',v_saved_at);
end
$function$;

create function api.complete_visit(p_device_id uuid, p_idempotency_key uuid, p_command jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $function$
declare
  actor_id uuid := private.visit_attachment_identity(); visit_row api.visits%rowtype;
  v_offline_id uuid; v_device_completed_at timestamptz; v_server_completed_at timestamptz := clock_timestamp();
  evidence jsonb; location_document jsonb; v_attachment_offline_id uuid; v_attachment_id uuid; v_evidence_id uuid;
  v_captured_at timestamptz; v_latitude numeric; v_longitude numeric; v_accuracy numeric; v_distance numeric;
  v_issues text[]; v_justification text; v_hash text;
begin
  if p_device_id is null or p_idempotency_key is null
     or jsonb_typeof(p_command) is distinct from 'object'
     or p_command -> 'schemaVersion' is distinct from '1'::jsonb
     or jsonb_typeof(p_command -> 'evidence') is distinct from 'object'
     or jsonb_typeof(p_command -> 'evidence' -> 'location') is distinct from 'object'
     or jsonb_typeof(p_command -> 'evidence' -> 'issues') is distinct from 'array' then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  begin
    v_offline_id := (p_command ->> 'offlineId')::uuid;
    v_device_completed_at := (p_command ->> 'deviceCompletedAt')::timestamptz;
    evidence := p_command -> 'evidence'; v_evidence_id := (evidence ->> 'offlineId')::uuid;
    v_attachment_offline_id := nullif(evidence ->> 'attachmentOfflineId','')::uuid;
    v_captured_at := (evidence ->> 'capturedAt')::timestamptz;
    location_document := evidence -> 'location';
    v_latitude := nullif(location_document ->> 'latitude','')::numeric;
    v_longitude := nullif(location_document ->> 'longitude','')::numeric;
    v_accuracy := nullif(location_document ->> 'accuracyM','')::numeric;
    v_distance := nullif(location_document ->> 'distanceM','')::numeric;
    select coalesce(array_agg(value), '{}') into v_issues from jsonb_array_elements_text(evidence -> 'issues') value;
    v_justification := nullif(trim(evidence ->> 'justification'), '');
  exception when others then raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED'; end;
  if v_offline_id is null or v_device_completed_at is null or v_evidence_id is null
     or v_captured_at is null
     or cardinality(v_issues) > 5
     or exists (
       select 1 from unnest(v_issues) issue
       where issue not in ('camera_unavailable','gps_unavailable','gps_low_accuracy','outside_radius','client_location_missing')
     )
     or (v_latitude is null) <> (v_longitude is null)
     or (v_latitude is not null and abs(v_latitude) > 90)
     or (v_longitude is not null and abs(v_longitude) > 180)
     or (v_accuracy is not null and v_accuracy < 0)
     or (v_distance is not null and v_distance < 0)
     or (v_attachment_offline_id is null and not ('camera_unavailable' = any(v_issues))) then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  v_hash := encode(extensions.digest(convert_to(p_command::text, 'UTF8'), 'sha256'), 'hex');
  select * into visit_row from api.visits visit where visit.seller_id = actor_id
    and visit.device_id = p_device_id and visit.offline_id = v_offline_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'FORBIDDEN'; end if;
  if visit_row.status = 'completed' then
    if visit_row.completion_payload_hash <> v_hash then raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSED'; end if;
    return jsonb_build_object('schemaVersion',1,'visitId',visit_row.id,'offlineId',visit_row.offline_id,
      'status','completed','deviceCompletedAt',visit_row.device_completed_at,'serverCompletedAt',visit_row.server_completed_at);
  end if;
  if not exists (select 1 from api.stock_snapshots stock where stock.visit_id = visit_row.id)
     or not exists (select 1 from api.competitor_price_reports prices where prices.visit_id = visit_row.id) then
    raise exception using errcode = 'P0001', message = 'EVENT_OUT_OF_ORDER';
  end if;
  if v_attachment_offline_id is not null and not exists (
    select 1 from api.visit_attachments attachment where attachment.visit_id = visit_row.id
      and attachment.offline_id = v_attachment_offline_id and attachment.purpose = 'visit_checkout'
      and attachment.status = 'verified') then
    raise exception using errcode = 'P0001', message = 'EVENT_OUT_OF_ORDER';
  end if;
  if cardinality(v_issues) > 0 and (v_justification is null or length(v_justification) < 10) then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  select attachment.id into v_attachment_id from api.visit_attachments attachment
    where attachment.visit_id=visit_row.id and attachment.offline_id=v_attachment_offline_id;
  insert into api.location_events (id, visit_id, kind, device_captured_at, server_received_at,
    position, accuracy_m, distance_m, exception_reason, issues, attachment_id, evidence_payload_hash)
  values (v_evidence_id, visit_row.id, 'completion', v_captured_at,
    v_server_completed_at, case when v_latitude is null then null else
      extensions.st_setsrid(extensions.st_makepoint(v_longitude,v_latitude),4326)::extensions.geography end,
    v_accuracy, v_distance, v_justification, v_issues, v_attachment_id, v_hash);
  update api.visits set status='completed', device_completed_at=v_device_completed_at,
    server_completed_at=v_server_completed_at, completion_payload_hash=v_hash where id=visit_row.id;
  update api.route_stop_executions set status='completed', lock_version=lock_version+1
    where route_version_stop_id=visit_row.route_version_stop_id and status='in_visit';
  insert into private.audit_events (actor_id,target_type,target_id,action,after_data,origin,occurred_at)
  values (actor_id,'visit',visit_row.id,'visit.completed.v1',jsonb_build_object(
    'evidenceId',v_evidence_id,'hasPhoto',v_attachment_offline_id is not null,'issues',v_issues),
    'system',v_server_completed_at);
  return jsonb_build_object('schemaVersion',1,'visitId',visit_row.id,'offlineId',visit_row.offline_id,
    'status','completed','deviceCompletedAt',v_device_completed_at,'serverCompletedAt',v_server_completed_at);
end
$function$;

alter table api.visit_attachments owner to cirne_visit_executor;
alter function private.visit_attachment_identity() owner to cirne_visit_executor;
alter function private.can_access_visit_attachment(text) owner to cirne_visit_executor;
alter function api.reserve_visit_attachment(uuid,uuid,jsonb) owner to cirne_visit_executor;
alter function api.get_visit_attachment_for_confirmation(uuid,uuid) owner to cirne_visit_executor;
alter function api.confirm_visit_attachment(uuid,uuid,uuid,text) owner to cirne_visit_executor;
alter function api.save_visit_checkin_evidence(uuid,uuid,jsonb) owner to cirne_visit_executor;
alter function api.complete_visit(uuid,uuid,jsonb) owner to cirne_visit_executor;

reset role;
revoke create on schema api, private from cirne_visit_executor;

create function api.list_expired_visit_evidence(p_limit integer default 500)
returns table (attachment_id uuid, storage_path text)
language sql stable security definer set search_path = '' as $function$
  select attachment.id, attachment.storage_path
  from api.visit_attachments attachment
  where attachment.expires_at <= clock_timestamp()
  order by attachment.expires_at, attachment.id
  limit least(greatest(p_limit, 1), 5000);
$function$;

-- The scheduled service-role worker must remove each object through the
-- Supabase Storage API first. This finalizer only removes metadata after the
-- object is absent, avoiding unsupported direct writes to storage.objects.
create function api.purge_expired_visit_evidence(p_limit integer default 500)
returns integer language plpgsql volatile security definer set search_path = '' as $function$
declare removed integer;
begin
  with expired as (
    select attachment.id
    from api.visit_attachments attachment
    where attachment.expires_at <= clock_timestamp()
      and not exists (
        select 1 from storage.objects object
        where object.bucket_id = 'visit-evidence'
          and object.name = attachment.storage_path
      )
    order by attachment.expires_at, attachment.id
    limit least(greatest(p_limit, 1), 5000)
    for update skip locked
  ), detached as (
    update api.location_events event
       set attachment_id = null
      from expired
     where event.attachment_id = expired.id
    returning event.id
  )
  delete from api.visit_attachments attachment
  using expired
  where attachment.id = expired.id;
  get diagnostics removed = row_count;
  return removed;
end
$function$;

revoke all on function api.reserve_visit_attachment(uuid,uuid,jsonb),
  api.get_visit_attachment_for_confirmation(uuid,uuid), api.confirm_visit_attachment(uuid,uuid,uuid,text),
  api.save_visit_checkin_evidence(uuid,uuid,jsonb),
  api.complete_visit(uuid,uuid,jsonb) from public, anon;
grant execute on function api.reserve_visit_attachment(uuid,uuid,jsonb),
  api.get_visit_attachment_for_confirmation(uuid,uuid), api.confirm_visit_attachment(uuid,uuid,uuid,text),
  api.save_visit_checkin_evidence(uuid,uuid,jsonb),
  api.complete_visit(uuid,uuid,jsonb) to authenticated;
revoke all on function api.list_expired_visit_evidence(integer),
  api.purge_expired_visit_evidence(integer) from public, anon, authenticated;
grant execute on function api.list_expired_visit_evidence(integer),
  api.purge_expired_visit_evidence(integer) to service_role;
grant execute on function private.can_access_visit_attachment(text) to authenticated;

do $ownership$
begin
  execute pg_catalog.format('revoke cirne_visit_executor from %I granted by current_user', current_user);
end
$ownership$;

commit;
