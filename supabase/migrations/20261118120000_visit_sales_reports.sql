-- Story 4.40: seller-declared sales, independent of stock and official sales.
begin;
select pg_catalog.set_config('cirne.migration_invoker', current_user, true);
select pg_catalog.set_config('cirne.sales_migration_had_visit_references',
  pg_catalog.has_table_privilege(current_user,'api.visits','REFERENCES')::text,true);
select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cirne:database:migrate'));
set local lock_timeout = '5s';

create role cirne_visit_sales_executor
  nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
do $membership$
declare executor text;
begin
  foreach executor in array array['cirne_visit_sales_executor','cirne_visit_executor',
    'cirne_sync_executor','cirne_identity_executor','cirne_scrap_executor','cirne_visit_detail_executor','cirne_route_executor'] loop
    execute pg_catalog.format('grant %I to %I with set true granted by current_user', executor, current_user);
  end loop;
end
$membership$;
grant usage on schema api, private, extensions to cirne_visit_sales_executor;
grant create on schema api, private to cirne_visit_sales_executor;
grant create on schema private to cirne_visit_executor, cirne_visit_detail_executor, cirne_scrap_executor;

set local role cirne_identity_executor;
grant execute on function private.resolve_current_identity() to cirne_visit_sales_executor;
reset role;
-- The existing geofence checkout reads only these client columns. Its original
-- migration omitted both this ACL and the forced-RLS observed-location policies.
set local role cirne_route_executor;
grant select (id,location) on api.clients to cirne_visit_executor;
create policy clients_checkout_executor_read on api.clients for select to cirne_visit_executor
  using (exists (select 1 from api.visits visit where visit.client_id = clients.id
    and visit.seller_id = (private.resolve_current_identity() ->> 'id')::uuid));
reset role;
set local role cirne_visit_executor;
create policy observed_locations_checkout_executor_read on api.client_observed_locations
  for select to cirne_visit_executor using (exists (select 1 from api.visits visit
    where visit.id = source_visit_id and visit.client_id = client_observed_locations.client_id
      and visit.seller_id = (private.resolve_current_identity() ->> 'id')::uuid));
create policy observed_locations_checkout_executor_insert on api.client_observed_locations
  for insert to cirne_visit_executor with check (exists (select 1 from api.visits visit
    where visit.id = source_visit_id and visit.client_id = client_observed_locations.client_id
      and visit.seller_id = (private.resolve_current_identity() ->> 'id')::uuid));
create policy observed_locations_checkout_executor_update on api.client_observed_locations
  for update to cirne_visit_executor using (exists (select 1 from api.visits visit
    where visit.id = source_visit_id and visit.client_id = client_observed_locations.client_id
      and visit.seller_id = (private.resolve_current_identity() ->> 'id')::uuid))
  with check (exists (select 1 from api.visits visit
    where visit.id = source_visit_id and visit.client_id = client_observed_locations.client_id
      and visit.seller_id = (private.resolve_current_identity() ->> 'id')::uuid));
do $reference_grant$ begin
  if not current_setting('cirne.sales_migration_had_visit_references')::boolean then
    execute pg_catalog.format('grant references on api.visits to %I', current_setting('cirne.migration_invoker'));
  end if;
end $reference_grant$;
grant select on api.visits to cirne_visit_sales_executor;
create policy visits_sales_executor_read on api.visits
  for select to cirne_visit_sales_executor using (true);

-- Serialize writes with checkout without giving the sales executor UPDATE on visits.
create function private.lock_visit_for_sales(p_device_id uuid, p_offline_id uuid)
returns uuid language plpgsql volatile security definer set search_path = '' as $function$
declare identity_document jsonb := private.resolve_current_identity(); visit_row api.visits%rowtype;
begin
  if identity_document is null
    or not (identity_document -> 'roles' @> '["seller"]'::jsonb)
    or not (identity_document -> 'capabilities' @> '["visit.start_self","sync.write_self"]'::jsonb) then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;
  select * into visit_row from api.visits visit
    where visit.seller_id = (identity_document ->> 'id')::uuid
      and visit.device_id = p_device_id and visit.offline_id = p_offline_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'FORBIDDEN'; end if;
  if visit_row.status <> 'in_progress' then
    raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT';
  end if;
  return visit_row.id;
end
$function$;
revoke all on function private.lock_visit_for_sales(uuid,uuid) from public, anon, authenticated;
grant execute on function private.lock_visit_for_sales(uuid,uuid) to cirne_visit_sales_executor;
reset role;

create table api.visit_sales_reports (
  id uuid primary key default gen_random_uuid(),
  visit_id uuid not null unique references api.visits(id) on delete restrict,
  heliar_quantity integer not null check (heliar_quantity >= 0),
  america_quantity integer not null check (america_quantity >= 0),
  strada_durex_quantity integer not null check (strada_durex_quantity >= 0),
  version integer not null check (version > 0),
  last_event_id uuid not null,
  device_saved_at timestamptz not null,
  server_saved_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table api.visit_sales_reports is
  'Seller declaration during a visit; does not change inventory or official sales.';
alter table api.visit_sales_reports owner to cirne_visit_sales_executor;
alter table api.visit_sales_reports enable row level security;
alter table api.visit_sales_reports force row level security;
revoke all on api.visit_sales_reports from public, anon, authenticated;
create policy visit_sales_executor_all on api.visit_sales_reports
  for all to cirne_visit_sales_executor using (true) with check (true);
grant select on api.visit_sales_reports to cirne_visit_detail_executor;
create policy visit_sales_detail_executor_read on api.visit_sales_reports
  for select to cirne_visit_detail_executor using (true);

set local role cirne_visit_executor;
do $reference_revoke$ begin
  if not current_setting('cirne.sales_migration_had_visit_references')::boolean then
    execute pg_catalog.format('revoke references on api.visits from %I', current_setting('cirne.migration_invoker'));
  end if;
end $reference_revoke$;
reset role;
grant select on api.visit_commercial_action_reports to cirne_visit_sales_executor;
create policy action_reports_sales_executor_read on api.visit_commercial_action_reports
  for select to cirne_visit_sales_executor using (true);

set local role cirne_sync_executor;
grant select, insert on private.sync_events to cirne_visit_sales_executor;
grant insert on private.audit_events to cirne_visit_sales_executor;
alter table private.sync_events drop constraint sync_events_operation_check;
alter table private.sync_events add constraint sync_events_operation_check check (operation in (
  'visit.draft.saved','visit.started.v1','visit.stock.saved.v1','visit.prices.saved.v1',
  'visit.commercial-actions.saved.v1','visit.scrap.saved.v1','visit.sales.saved.v1'
));
reset role;

set local role cirne_scrap_executor;
alter function private.sync_event(uuid,jsonb) rename to sync_event_before_sales;
grant execute on function private.sync_event_before_sales(uuid,jsonb) to cirne_visit_sales_executor;
reset role;

set local role cirne_visit_sales_executor;
create function private.visit_sales_identity()
returns uuid language plpgsql stable security definer set search_path = '' as $function$
declare identity_document jsonb := private.resolve_current_identity();
begin
  if identity_document is null
    or not (identity_document -> 'roles' @> '["seller"]'::jsonb)
    or not (identity_document -> 'capabilities' @> '["visit.start_self","sync.write_self"]'::jsonb) then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;
  return (identity_document ->> 'id')::uuid;
end
$function$;

create function api.get_visit_sales(p_device_id uuid, p_offline_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $function$
declare actor_id uuid := private.visit_sales_identity(); visit_row api.visits%rowtype; result_document jsonb;
begin
  select * into visit_row from api.visits visit
    where visit.seller_id = actor_id and visit.device_id = p_device_id and visit.offline_id = p_offline_id;
  if not found then raise exception using errcode = 'P0001', message = 'FORBIDDEN'; end if;
  select jsonb_build_object('schemaVersion',1,'reportId',report.id,'visitId',visit_row.id,
    'offlineId',visit_row.offline_id,'heliarQuantity',report.heliar_quantity,
    'americaQuantity',report.america_quantity,'stradaDurexQuantity',report.strada_durex_quantity,
    'version',report.version,'deviceSavedAt',report.device_saved_at,'serverSavedAt',report.server_saved_at)
    into result_document from api.visit_sales_reports report where report.visit_id = visit_row.id;
  return result_document;
end
$function$;

create function private.sync_event(p_device_id uuid, p_command jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $function$
#variable_conflict use_variable
declare
  actor_id uuid; event_id uuid; intent_key uuid; aggregate_id uuid; event_sequence integer;
  occurred_at timestamptz; saved_at timestamptz; payload jsonb; payload_hash text;
  previous_event private.sync_events%rowtype; previous_sequence integer;
  visit_row api.visits%rowtype; report_row api.visit_sales_reports%rowtype;
  before_document jsonb; expected_version integer; report_id uuid;
  stamp timestamptz := clock_timestamp(); confirmation jsonb; quantity_key text;
begin
  if p_command ->> 'operation' is distinct from 'visit.sales.saved.v1' then
    return private.sync_event_before_sales(p_device_id,p_command);
  end if;
  actor_id := private.visit_sales_identity();
  if p_device_id is null or jsonb_typeof(p_command) is distinct from 'object'
    or not (p_command ?& array['eventId','idempotencyKey','operation','schemaVersion','sequence',
      'aggregateType','aggregateId','occurredAt','payload'])
    or (select count(*) from jsonb_object_keys(p_command)) <> 9
    or p_command -> 'schemaVersion' is distinct from '1'::jsonb
    or p_command ->> 'aggregateType' is distinct from 'visit'
    or jsonb_typeof(p_command -> 'sequence') is distinct from 'number'
    or (p_command ->> 'sequence') !~ '^[1-9][0-9]*$' then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  event_id := (p_command ->> 'eventId')::uuid;
  intent_key := (p_command ->> 'idempotencyKey')::uuid;
  aggregate_id := (p_command ->> 'aggregateId')::uuid;
  event_sequence := (p_command ->> 'sequence')::integer;
  occurred_at := (p_command ->> 'occurredAt')::timestamptz;
  payload := p_command -> 'payload';
  if event_id is null or intent_key is null or aggregate_id is null or occurred_at is null
    or not isfinite(occurred_at) or jsonb_typeof(payload) is distinct from 'object'
    or not (payload ?& array['offlineId','expectedVersion','heliarQuantity','americaQuantity',
      'stradaDurexQuantity','deviceSavedAt'])
    or (select count(*) from jsonb_object_keys(payload)) <> 6
    or (payload ->> 'offlineId')::uuid is distinct from aggregate_id then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  foreach quantity_key in array array['expectedVersion','heliarQuantity','americaQuantity','stradaDurexQuantity'] loop
    if jsonb_typeof(payload -> quantity_key) is distinct from 'number'
      or (payload ->> quantity_key) !~ '^[0-9]+$' then
      raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
    end if;
    perform (payload ->> quantity_key)::integer;
  end loop;
  expected_version := (payload ->> 'expectedVersion')::integer;
  saved_at := (payload ->> 'deviceSavedAt')::timestamptz;
  if saved_at is null or not isfinite(saved_at) then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  payload_hash := encode(extensions.digest(convert_to(jsonb_build_object(
    'operation','visit.sales.saved.v1','schemaVersion',1,'aggregateType','visit',
    'aggregateId',aggregate_id,'sequence',event_sequence,
    'occurredAt',to_char(occurred_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'payload',payload)::text,'UTF8'),'sha256'),'hex');

  perform pg_advisory_xact_lock(hashtextextended(
    actor_id::text || ':' || p_device_id::text || ':visit.sales.saved.v1:' || intent_key::text,0));
  perform pg_advisory_xact_lock(hashtextextended(
    actor_id::text || ':' || p_device_id::text || ':visit:' || aggregate_id::text,1));
  -- Authorization precedes even an immutable replay. A completed visit may replay
  -- an old confirmation, but a new intention is rejected by the row-lock helper.
  select * into visit_row from api.visits visit where visit.seller_id = actor_id
    and visit.device_id = p_device_id and visit.offline_id = aggregate_id;
  if not found then raise exception using errcode = 'P0001', message = 'FORBIDDEN'; end if;
  select * into previous_event from private.sync_events stored where stored.actor_id = actor_id
    and stored.device_id = p_device_id and stored.operation = 'visit.sales.saved.v1'
    and stored.idempotency_key = intent_key;
  if found then
    if previous_event.payload_hash <> payload_hash then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return previous_event.canonical_result;
  end if;
  if exists (select 1 from private.sync_events stored where stored.actor_id = actor_id
    and stored.device_id = p_device_id and stored.event_id = event_id) then
    raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSED';
  end if;
  select max(stored.sequence) into previous_sequence from private.sync_events stored
    where stored.actor_id = actor_id and stored.device_id = p_device_id
      and stored.aggregate_type = 'visit' and stored.aggregate_id = aggregate_id;
  if previous_sequence is null or event_sequence <> previous_sequence + 1 then
    raise exception using errcode = 'P0001', message = 'EVENT_OUT_OF_ORDER';
  end if;
  perform private.lock_visit_for_sales(p_device_id,aggregate_id);
  if not exists (select 1 from api.visit_commercial_action_reports report where report.visit_id = visit_row.id) then
    raise exception using errcode = 'P0001', message = 'EVENT_OUT_OF_ORDER';
  end if;
  select * into report_row from api.visit_sales_reports report where report.visit_id = visit_row.id;
  if coalesce(report_row.version,0) <> expected_version then
    raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT';
  end if;
  if report_row.id is not null then before_document := to_jsonb(report_row); end if;
  insert into api.visit_sales_reports(visit_id,heliar_quantity,america_quantity,strada_durex_quantity,
    version,last_event_id,device_saved_at,server_saved_at)
  values(visit_row.id,(payload ->> 'heliarQuantity')::integer,(payload ->> 'americaQuantity')::integer,
    (payload ->> 'stradaDurexQuantity')::integer,expected_version+1,event_id,saved_at,stamp)
  on conflict (visit_id) do update set heliar_quantity = excluded.heliar_quantity,
    america_quantity = excluded.america_quantity,strada_durex_quantity = excluded.strada_durex_quantity,
    version = excluded.version,last_event_id = excluded.last_event_id,device_saved_at = excluded.device_saved_at,
    server_saved_at = excluded.server_saved_at,updated_at = stamp
  returning id into report_id;
  confirmation := jsonb_build_object('eventId',event_id,'status','confirmed',
    'canonicalId',visit_row.id,'confirmedAt',stamp);
  insert into private.sync_events(actor_id,device_id,event_id,idempotency_key,operation,schema_version,
    sequence,payload_hash,aggregate_type,aggregate_id,status,attempt_count,canonical_result,occurred_at,confirmed_at)
  values(actor_id,p_device_id,event_id,intent_key,'visit.sales.saved.v1',1,event_sequence,payload_hash,
    'visit',aggregate_id,'confirmed',1,confirmation,occurred_at,stamp);
  insert into private.audit_events(actor_id,target_type,target_id,action,before_data,after_data,origin,request_id,occurred_at)
  values(actor_id,'visit',visit_row.id,'visit.sales.saved.v1',before_document,
    jsonb_build_object('reportId',report_id,'version',expected_version+1,'payload',payload),'system',intent_key,stamp);
  return confirmation;
exception when invalid_text_representation or numeric_value_out_of_range
  or invalid_datetime_format or datetime_field_overflow or check_violation or not_null_violation then
  raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
end
$function$;

create function api.save_visit_sales(p_device_id uuid, p_idempotency_key uuid, p_command jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $function$
#variable_conflict use_variable
declare actor_id uuid := private.visit_sales_identity(); offline_id uuid;
  previous_event private.sync_events%rowtype; event_sequence integer; event_id uuid;
  confirmation jsonb; result_document jsonb;
begin
  if p_device_id is null or p_idempotency_key is null or jsonb_typeof(p_command) is distinct from 'object'
    or p_command -> 'schemaVersion' is distinct from '1'::jsonb
    or not (p_command ?& array['schemaVersion','offlineId','expectedVersion','heliarQuantity',
      'americaQuantity','stradaDurexQuantity','deviceSavedAt'])
    or (select count(*) from jsonb_object_keys(p_command)) <> 7 then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  offline_id := (p_command ->> 'offlineId')::uuid;
  if offline_id is null then raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED'; end if;
  perform pg_advisory_xact_lock(hashtextextended(
    actor_id::text || ':' || p_device_id::text || ':visit.sales.saved.v1:' || p_idempotency_key::text,0));
  perform pg_advisory_xact_lock(hashtextextended(
    actor_id::text || ':' || p_device_id::text || ':visit:' || offline_id::text,1));
  select * into previous_event from private.sync_events stored where stored.actor_id = actor_id
    and stored.device_id = p_device_id and stored.operation = 'visit.sales.saved.v1'
    and stored.idempotency_key = p_idempotency_key;
  if found then
    event_id := previous_event.event_id; event_sequence := previous_event.sequence;
  else
    event_id := p_idempotency_key;
    select coalesce(max(stored.sequence),0)+1 into event_sequence from private.sync_events stored
      where stored.actor_id = actor_id and stored.device_id = p_device_id
        and stored.aggregate_type = 'visit' and stored.aggregate_id = offline_id;
  end if;
  confirmation := private.sync_event(p_device_id,jsonb_build_object('eventId',event_id,
    'idempotencyKey',p_idempotency_key,'operation','visit.sales.saved.v1','schemaVersion',1,
    'sequence',event_sequence,'aggregateType','visit','aggregateId',offline_id,
    'occurredAt',p_command ->> 'deviceSavedAt','payload',p_command-'schemaVersion'));
  result_document := api.get_visit_sales(p_device_id,offline_id);
  -- Reconstruct the intention's result, not the current mutable report's values.
  return result_document || jsonb_build_object('heliarQuantity',p_command -> 'heliarQuantity',
    'americaQuantity',p_command -> 'americaQuantity','stradaDurexQuantity',p_command -> 'stradaDurexQuantity',
    'version',(p_command ->> 'expectedVersion')::integer+1,'deviceSavedAt',p_command ->> 'deviceSavedAt',
    'serverSavedAt',confirmation -> 'confirmedAt');
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
end
$function$;

create function private.require_sales_before_completion()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  if new.status = 'completed' and old.status is distinct from 'completed'
    and not exists (select 1 from api.visit_sales_reports report where report.visit_id = new.id) then
    raise exception using errcode = 'P0001', message = 'EVENT_OUT_OF_ORDER';
  end if;
  return new;
end
$function$;
revoke all on function private.visit_sales_identity(), private.sync_event(uuid,jsonb),
  private.require_sales_before_completion(), api.get_visit_sales(uuid,uuid),
  api.save_visit_sales(uuid,uuid,jsonb) from public, anon, authenticated;
grant execute on function private.sync_event(uuid,jsonb) to cirne_sync_executor, cirne_visit_executor;
grant execute on function private.require_sales_before_completion() to cirne_visit_executor;
grant execute on function api.get_visit_sales(uuid,uuid), api.save_visit_sales(uuid,uuid,jsonb) to authenticated;
reset role;

set local role cirne_visit_executor;
create trigger require_visit_sales_before_completion before update of status on api.visits
  for each row execute function private.require_sales_before_completion();
reset role;

set local role cirne_visit_detail_executor;
alter function private.get_visit_detail(uuid,uuid,text) rename to get_visit_detail_before_sales;
create function private.get_visit_detail(p_visit_id uuid, p_request_id uuid, p_origin text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $function$
declare result_document jsonb; sales_document jsonb;
begin
  -- The established reader authorizes capability, active identity and management scope.
  result_document := private.get_visit_detail_before_sales(p_visit_id,p_request_id,p_origin);
  select jsonb_build_object('state','available','recordedAt',report.server_saved_at,
    'heliarQuantity',report.heliar_quantity,'americaQuantity',report.america_quantity,
    'stradaDurexQuantity',report.strada_durex_quantity)
    into sales_document from api.visit_sales_reports report where report.visit_id = p_visit_id;
  return jsonb_set(result_document,'{sections,sales}',coalesce(sales_document,jsonb_build_object('state','absent')));
end
$function$;
revoke all on function private.get_visit_detail(uuid,uuid,text) from public,anon,authenticated;
reset role;

revoke create on schema api, private from cirne_visit_sales_executor;
revoke create on schema private from cirne_visit_executor, cirne_visit_detail_executor, cirne_scrap_executor;
do $membership$
declare executor text;
begin
  foreach executor in array array['cirne_visit_sales_executor','cirne_visit_executor',
    'cirne_sync_executor','cirne_identity_executor','cirne_scrap_executor','cirne_visit_detail_executor','cirne_route_executor'] loop
    execute pg_catalog.format('revoke %I from %I granted by current_user',executor,current_user);
  end loop;
end
$membership$;
commit;
