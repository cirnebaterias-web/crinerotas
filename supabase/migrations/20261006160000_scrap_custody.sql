-- Story 3.10 / ADR 004: seller collection, logistics receipt and future pickup.
begin;
select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cirne:database:migrate'));
set local lock_timeout = '5s';
create role cirne_scrap_executor nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
do $membership$ begin
  execute format('grant cirne_scrap_executor to %I with set true granted by current_user', current_user);
  execute format('grant cirne_identity_executor to %I with set true granted by current_user', current_user);
  execute format('grant cirne_route_executor to %I with set true granted by current_user', current_user);
  execute format('grant cirne_visit_executor to %I with set true granted by current_user', current_user);
  execute format('grant cirne_sync_executor to %I with set true granted by current_user', current_user);
end $membership$;
alter table api.roles drop constraint roles_code_check;
alter table api.roles add constraint roles_code_check check(code in('seller','manager','administrator','logistics'));
insert into api.roles(id,code,name) values ('00000000-0000-4000-8000-000000000004','logistics','Logística');
insert into api.role_permissions(role_id,permission_code) values
('00000000-0000-4000-8000-000000000004','identity.read_self'),
('00000000-0000-4000-8000-000000000004','scrap.read_operations'),
('00000000-0000-4000-8000-000000000004','scrap.receive'),
('00000000-0000-4000-8000-000000000001','scrap.collect_self'),
('00000000-0000-4000-8000-000000000001','scrap.schedule_self'),
('00000000-0000-4000-8000-000000000002','scrap.read_operations'),
('00000000-0000-4000-8000-000000000002','scrap.manage_points'),
('00000000-0000-4000-8000-000000000003','scrap.read_operations'),
('00000000-0000-4000-8000-000000000003','scrap.manage_points');
grant select on api.user_profiles to cirne_scrap_executor;
create policy user_profiles_scrap_read on api.user_profiles for select to cirne_scrap_executor using(true);
do $refs$ begin execute format('grant references on api.user_profiles to %I',session_user); end $refs$;
set local role cirne_identity_executor;
grant execute on function private.resolve_current_identity() to cirne_scrap_executor;
reset role;
set local role cirne_route_executor;
grant select on api.clients to cirne_scrap_executor;
create policy clients_scrap_read on api.clients for select to cirne_scrap_executor using(true);
do $refs$ begin execute format('grant references on api.clients to %I',session_user); end $refs$;
reset role;
set local role cirne_visit_executor;
grant select on api.visits to cirne_scrap_executor;
create policy visits_scrap_read on api.visits for select to cirne_scrap_executor using(true);
-- Commercial action reports are owned by the migration role, policy is added below.
do $refs$ begin execute format('grant references on api.visits to %I',session_user); end $refs$;
reset role;
grant select on api.visit_commercial_action_reports to cirne_scrap_executor;
create policy action_reports_scrap_read on api.visit_commercial_action_reports for select to cirne_scrap_executor using(true);
grant create on schema private to cirne_sync_executor;
set local role cirne_sync_executor;
grant select,insert on private.sync_events to cirne_scrap_executor;
grant insert on private.audit_events to cirne_scrap_executor;
alter table private.sync_events drop constraint sync_events_operation_check;
alter table private.sync_events add constraint sync_events_operation_check check(operation in
('visit.draft.saved','visit.started.v1','visit.stock.saved.v1','visit.prices.saved.v1','visit.commercial-actions.saved.v1','visit.scrap.saved.v1'));
alter function private.sync_event(uuid,jsonb) rename to sync_event_before_scrap;
grant execute on function private.sync_event_before_scrap(uuid,jsonb) to cirne_scrap_executor;
reset role;

create table api.scrap_concentration_points(
id uuid primary key default gen_random_uuid(),name text not null check(length(trim(name)) between 1 and 160),
address text not null check(length(trim(address)) between 1 and 300),active boolean not null default true,
version integer not null default 1 check(version>0),created_by uuid not null references api.user_profiles(id) on delete restrict,
updated_by uuid not null references api.user_profiles(id) on delete restrict,
created_at timestamptz not null default now(),updated_at timestamptz not null default now());
create table api.scrap_reports(
id uuid primary key default gen_random_uuid(),visit_id uuid not null unique references api.visits(id) on delete restrict,
availability text not null check(availability in('none','collected','scheduled')),last_event_id uuid not null,
device_saved_at timestamptz not null,created_at timestamptz not null default now(),updated_at timestamptz not null default now());
create table api.scrap_collections(
id uuid primary key default gen_random_uuid(),offline_id uuid not null,seller_id uuid not null references api.user_profiles(id) on delete restrict,
device_id uuid not null,report_id uuid not null unique references api.scrap_reports(id) on delete restrict,
client_id uuid not null references api.clients(id) on delete restrict,client_name_snapshot text not null,address_snapshot text not null,
seller_name_snapshot text not null,actual_weight_kg numeric not null check(actual_weight_kg>0 and actual_weight_kg<'Infinity'::numeric),
collected_at timestamptz not null,receipt_number text not null check(length(trim(receipt_number)) between 1 and 120),
client_signed boolean not null check(client_signed),seller_signed boolean not null check(seller_signed),two_copies boolean not null check(two_copies),
destination_type text not null check(destination_type in('concentration_point','headquarters')),
concentration_point_id uuid references api.scrap_concentration_points(id) on delete restrict,
destination_name_snapshot text not null,destination_address_snapshot text not null,
attachment_offline_ids uuid[] not null check(cardinality(attachment_offline_ids) between 1 and 4),
status text not null default 'awaiting_receipt' check(status in('awaiting_receipt','received')),
version integer not null default 1 check(version>0),last_event_at timestamptz not null default now(),retention_until timestamptz,
created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
unique(seller_id,device_id,offline_id),check((destination_type='concentration_point')=(concentration_point_id is not null)),
check((status='awaiting_receipt' and retention_until is null) or (status='received' and retention_until>=last_event_at+interval '5 years')));
create table api.pickup_schedules(
id uuid primary key default gen_random_uuid(),offline_id uuid not null,seller_id uuid not null references api.user_profiles(id) on delete restrict,
device_id uuid not null,visit_id uuid references api.visits(id) on delete restrict,
report_id uuid unique references api.scrap_reports(id) on delete restrict,client_id uuid not null references api.clients(id) on delete restrict,
client_name_snapshot text not null,address_snapshot text not null,seller_name_snapshot text not null,
estimated_weight_kg numeric not null check(estimated_weight_kg>0 and estimated_weight_kg<'Infinity'::numeric),
desired_date date not null,period text not null check(period in('morning','afternoon')),observation text check(length(observation)<=1200),
requested_at timestamptz not null,origin text not null check(origin in('visit','standalone')),
status text not null default 'pending' check(status='pending'),version integer not null default 1,
last_event_at timestamptz not null default now(),retention_until timestamptz check(retention_until is null),
created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
unique(seller_id,device_id,offline_id),check((origin='visit')=(visit_id is not null)));
create table api.scrap_receipts(
id uuid primary key default gen_random_uuid(),collection_id uuid not null unique references api.scrap_collections(id) on delete restrict,
received_by uuid not null references api.user_profiles(id) on delete restrict,receiver_name_snapshot text not null,
received_weight_kg numeric not null check(received_weight_kg>0 and received_weight_kg<'Infinity'::numeric),difference_kg numeric not null,
received_location text not null check(length(trim(received_location)) between 1 and 300),observation text check(length(observation)<=1200),
received_at timestamptz not null default now(),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
check(difference_kg=0 or (observation is not null and length(trim(observation))>0)));
create table api.pickup_schedule_revisions(
id uuid primary key default gen_random_uuid(),schedule_id uuid not null references api.pickup_schedules(id) on delete restrict,
actor_id uuid not null references api.user_profiles(id) on delete restrict,reason text not null check(length(trim(reason)) between 1 and 500),
before_data jsonb not null,after_data jsonb not null,created_at timestamptz not null default now(),updated_at timestamptz not null default now());
create table api.scrap_attachments(
id uuid primary key default gen_random_uuid(),offline_id uuid not null,collection_id uuid not null references api.scrap_collections(id) on delete restrict,
seller_id uuid not null references api.user_profiles(id) on delete restrict,device_id uuid not null,
storage_path text not null unique,content_type text not null check(content_type in('image/jpeg','image/webp')),
byte_size integer not null check(byte_size between 1 and 2097152),checksum text not null check(checksum~'^[0-9a-f]{64}$'),
captured_at timestamptz not null,status text not null default 'reserved' check(status in('reserved','verified')),
reservation_key uuid not null,reservation_hash text not null,verified_at timestamptz,confirmation_key uuid,
created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
unique(seller_id,device_id,offline_id),unique(seller_id,device_id,reservation_key),
check((status='reserved' and verified_at is null) or(status='verified' and verified_at is not null)));
create table private.scrap_commands(
id uuid primary key default gen_random_uuid(),actor_id uuid not null references api.user_profiles(id) on delete restrict,
operation text not null,idempotency_key uuid not null,payload_hash text not null,result jsonb not null,
created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(actor_id,operation,idempotency_key));
create index scrap_collections_seller_time on api.scrap_collections(seller_id,created_at desc);
create index scrap_collections_status_time on api.scrap_collections(status,created_at desc);
create index pickup_schedules_date on api.pickup_schedules(desired_date,period);
create index pickup_schedules_seller on api.pickup_schedules(seller_id,created_at desc);
create index scrap_attachments_collection on api.scrap_attachments(collection_id);
grant usage,create on schema api,private to cirne_scrap_executor;
grant usage on schema extensions to cirne_scrap_executor;
do $tables$ declare t text; begin
foreach t in array array['api.scrap_concentration_points','api.scrap_reports','api.scrap_collections','api.pickup_schedules','api.pickup_schedule_revisions','api.scrap_receipts','api.scrap_attachments','private.scrap_commands'] loop
execute format('alter table %s enable row level security',t);
execute format('alter table %s force row level security',t);
execute format('create policy scrap_executor_all on %s for all to cirne_scrap_executor using(true) with check(true)',t);
execute format('revoke all on %s from public,anon,authenticated',t);
execute format('grant select,insert,update on %s to cirne_scrap_executor',t);
end loop; end $tables$;
grant select on api.scrap_reports,api.scrap_collections,api.scrap_attachments to cirne_visit_executor;
create policy reports_completion_read on api.scrap_reports for select to cirne_visit_executor using(true);
create policy collections_completion_read on api.scrap_collections for select to cirne_visit_executor using(true);
create policy attachments_completion_read on api.scrap_attachments for select to cirne_visit_executor using(true);
set local role cirne_scrap_executor;
create function private.scrap_identity(p_capability text) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare d jsonb; begin d:=private.resolve_current_identity();
if d is null or not(d->'capabilities' ? p_capability) then raise exception using errcode='P0001',message='FORBIDDEN'; end if; return d; end $$;
create function private.scrap_visible(p_seller uuid) returns boolean language plpgsql stable security definer set search_path='' as $$
declare d jsonb:=private.resolve_current_identity(); begin
return d is not null and ((d->>'id')::uuid=p_seller or
((d->'capabilities' ? 'scrap.read_operations') and (d->'roles' ? 'administrator' or d->'roles' ? 'logistics' or d->'scopeIds' ? p_seller::text))); end $$;
create function private.scrap_audit(p_actor uuid,p_target uuid,p_action text,p_before jsonb,p_after jsonb,p_key uuid default null)
returns void language sql security definer set search_path='' as $$
insert into private.audit_events(actor_id,target_type,target_id,action,before_data,after_data,origin,request_id,occurred_at)
values(p_actor,'scrap',p_target,p_action,p_before,p_after,'system',p_key,clock_timestamp()); $$;
create function api.list_scrap_points(p_include_inactive boolean default false) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare d jsonb:=private.resolve_current_identity(); begin
if d is null or not(d->'capabilities' ?| array['scrap.collect_self','scrap.read_operations','scrap.manage_points']) then raise exception using errcode='P0001',message='FORBIDDEN'; end if;
if p_include_inactive and not(d->'capabilities' ? 'scrap.manage_points') then raise exception using errcode='P0001',message='FORBIDDEN'; end if;
return coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'address',address,'active',active,'version',version) order by name)
from api.scrap_concentration_points where active or p_include_inactive),'[]'); end $$;
create function api.save_scrap_point(p_command jsonb) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare d jsonb:=private.scrap_identity('scrap.manage_points'); actor uuid:=(d->>'id')::uuid; old api.scrap_concentration_points%rowtype; r api.scrap_concentration_points%rowtype; begin
if p_command->>'id' is null then
insert into api.scrap_concentration_points(name,address,active,created_by,updated_by) values(trim(p_command->>'name'),trim(p_command->>'address'),coalesce((p_command->>'active')::boolean,true),actor,actor) returning * into r;
else select * into old from api.scrap_concentration_points where id=(p_command->>'id')::uuid for update;
if not found then raise exception using errcode='P0001',message='NOT_FOUND'; end if;
if old.version is distinct from (p_command->>'expectedVersion')::integer then raise exception using errcode='P0001',message='VERSION_CONFLICT'; end if;
update api.scrap_concentration_points set name=trim(p_command->>'name'),address=trim(p_command->>'address'),active=(p_command->>'active')::boolean,
version=version+1,updated_by=actor,updated_at=clock_timestamp() where id=old.id returning * into r; end if;
perform private.scrap_audit(actor,r.id,'scrap.point.saved.v1',to_jsonb(old),to_jsonb(r));
return jsonb_build_object('id',r.id,'name',r.name,'address',r.address,'active',r.active,'version',r.version);
exception when check_violation or not_null_violation or invalid_text_representation then raise exception using errcode='P0001',message='VALIDATION_FAILED'; end $$;
create function api.search_scrap_clients(p_query text default '',p_limit integer default 30) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin perform private.scrap_identity('scrap.schedule_self');
if length(trim(p_query))<2 then return '[]'; end if;
return coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'address',address) order by name)
from(select id,name,address from api.clients where status='active' and archived_at is null and
(name ilike '%'||replace(replace(replace(trim(p_query),'\','\\'),'%','\%'),'_','\_')||'%' or external_reference=trim(p_query)) order by name limit least(greatest(p_limit,1),30)) q),'[]'); end $$;
create function api.create_pickup_schedule(p_device_id uuid,p_idempotency_key uuid,p_command jsonb) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare d jsonb:=private.scrap_identity('scrap.schedule_self'); actor uuid:=(d->>'id')::uuid; h text; previous private.scrap_commands%rowtype;
c api.clients%rowtype; v api.visits%rowtype; r api.pickup_schedules%rowtype; result jsonb; begin
if p_device_id is null or p_idempotency_key is null or p_command->'schemaVersion' is distinct from '1'::jsonb then raise exception using errcode='P0001',message='VALIDATION_FAILED'; end if;
h:=encode(extensions.digest(convert_to(jsonb_build_object('deviceId',p_device_id,'command',p_command)::text,'UTF8'),'sha256'),'hex');
perform pg_advisory_xact_lock(hashtextextended(actor::text||':schedule:'||p_idempotency_key,1));
select * into previous from private.scrap_commands where actor_id=actor and operation='schedule' and idempotency_key=p_idempotency_key;
if found then if previous.payload_hash<>h then raise exception using errcode='P0001',message='IDEMPOTENCY_KEY_REUSED'; end if; return previous.result; end if;
select * into c from api.clients where id=(p_command->>'clientId')::uuid and status='active' and archived_at is null;
if not found then raise exception using errcode='P0001',message='NOT_FOUND'; end if;
if p_command->>'visitOfflineId' is not null then select * into v from api.visits where seller_id=actor and device_id=p_device_id and offline_id=(p_command->>'visitOfflineId')::uuid;
if not found or v.client_id<>c.id or v.status<>'in_progress' then raise exception using errcode='P0001',message='FORBIDDEN'; end if; end if;
if (p_command->>'desiredDate')::date <= (clock_timestamp() at time zone 'America/Sao_Paulo')::date then raise exception using errcode='P0001',message='VALIDATION_FAILED'; end if;
insert into api.pickup_schedules(offline_id,seller_id,device_id,visit_id,client_id,client_name_snapshot,address_snapshot,seller_name_snapshot,estimated_weight_kg,desired_date,period,observation,requested_at,origin)
values((p_command->>'offlineId')::uuid,actor,p_device_id,v.id,c.id,c.name,c.address,d->>'displayName',(p_command->>'estimatedWeightKg')::numeric,(p_command->>'desiredDate')::date,p_command->>'period',nullif(trim(p_command->>'observation'),''),(p_command->>'requestedAt')::timestamptz,case when v.id is null then 'standalone' else 'visit' end) returning * into r;
result:=jsonb_build_object('id',r.id,'offlineId',r.offline_id,'client',jsonb_build_object('id',r.client_id,'name',r.client_name_snapshot,'address',r.address_snapshot),'seller',jsonb_build_object('id',actor,'displayName',r.seller_name_snapshot),'estimatedWeightKg',r.estimated_weight_kg::text,'desiredDate',r.desired_date,'period',r.period,'observation',r.observation,'requestedAt',r.requested_at,'origin',r.origin,'visitId',r.visit_id,'status',r.status,'version',r.version,'serverSavedAt',r.created_at);
insert into private.scrap_commands(actor_id,operation,idempotency_key,payload_hash,result) values(actor,'schedule',p_idempotency_key,h,result);
perform private.scrap_audit(actor,r.id,'scrap.schedule.created.v1',null,to_jsonb(r),p_idempotency_key); return result;
exception when check_violation or not_null_violation or invalid_text_representation or invalid_datetime_format or unique_violation then raise exception using errcode='P0001',message='VALIDATION_FAILED'; end $$;

create function private.sync_event(p_device_id uuid,p_command jsonb) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare d jsonb; actor uuid; event_id uuid; k uuid; aggregate uuid; seq integer; h text; previous private.sync_events%rowtype;
v api.visits%rowtype; c api.clients%rowtype; point api.scrap_concentration_points%rowtype; v_report_id uuid; col jsonb; item jsonb;
payload jsonb:=p_command->'payload'; stamp timestamptz:=clock_timestamp(); result jsonb; scheduled jsonb; max_seq integer; begin
if p_command->>'operation' is distinct from 'visit.scrap.saved.v1' then return private.sync_event_before_scrap(p_device_id,p_command); end if;
d:=private.scrap_identity('scrap.collect_self'); actor:=(d->>'id')::uuid;
event_id:=(p_command->>'eventId')::uuid;k:=(p_command->>'idempotencyKey')::uuid;aggregate:=(p_command->>'aggregateId')::uuid;seq:=(p_command->>'sequence')::integer;
if p_device_id is null or event_id is null or k is null or aggregate is null or seq is null or p_command->>'aggregateType' is distinct from 'visit' or payload->>'offlineId' is distinct from aggregate::text or payload->'schemaVersion' is distinct from '1'::jsonb then raise exception using errcode='P0001',message='VALIDATION_FAILED'; end if;
h:=encode(extensions.digest(convert_to(p_command::text,'UTF8'),'sha256'),'hex');
perform pg_advisory_xact_lock(hashtextextended(actor::text||':'||p_device_id::text||':visit:'||aggregate::text,1));
select * into previous from private.sync_events where actor_id=actor and device_id=p_device_id and operation='visit.scrap.saved.v1' and idempotency_key=k;
if found then if previous.payload_hash<>h then raise exception using errcode='P0001',message='IDEMPOTENCY_KEY_REUSED'; end if; return previous.canonical_result; end if;
select max(sequence) into max_seq from private.sync_events where actor_id=actor and device_id=p_device_id and aggregate_type='visit' and aggregate_id=aggregate;
if max_seq is null or seq<>max_seq+1 then raise exception using errcode='P0001',message='EVENT_OUT_OF_ORDER'; end if;
select * into v from api.visits where seller_id=actor and device_id=p_device_id and offline_id=aggregate;
if not found then raise exception using errcode='P0001',message='NOT_FOUND'; end if;
if v.status<>'in_progress' or not exists(select 1 from api.visit_commercial_action_reports where visit_id=v.id) or exists(select 1 from api.scrap_reports where visit_id=v.id) then raise exception using errcode='P0001',message='VERSION_CONFLICT'; end if;
select * into c from api.clients where id=v.client_id;
insert into api.scrap_reports(visit_id,availability,last_event_id,device_saved_at) values(v.id,payload->>'availability',event_id,(payload->>'deviceSavedAt')::timestamptz) returning id into v_report_id;
if payload->>'availability'='collected' then
col:=payload->'collection';
if col->>'destinationType'='concentration_point' then select * into point from api.scrap_concentration_points where id=(col->>'concentrationPointId')::uuid and active;
if not found then raise exception using errcode='P0001',message='VALIDATION_FAILED'; end if; end if;
if jsonb_typeof(col->'attachmentOfflineIds') is distinct from 'array' or jsonb_array_length(col->'attachmentOfflineIds') not between 1 and 4 then raise exception using errcode='P0001',message='VALIDATION_FAILED'; end if;
insert into api.scrap_collections(offline_id,seller_id,device_id,report_id,client_id,client_name_snapshot,address_snapshot,seller_name_snapshot,actual_weight_kg,collected_at,receipt_number,client_signed,seller_signed,two_copies,destination_type,concentration_point_id,destination_name_snapshot,destination_address_snapshot,attachment_offline_ids)
values((col->>'offlineId')::uuid,actor,p_device_id,v_report_id,c.id,c.name,c.address,d->>'displayName',(col->>'actualWeightKg')::numeric,(col->>'collectedAt')::timestamptz,trim(col->>'receiptNumber'),(col->>'clientSigned')::boolean,(col->>'sellerSigned')::boolean,(col->>'twoCopies')::boolean,col->>'destinationType',point.id,coalesce(point.name,'Matriz Cirne — Natal'),coalesce(point.address,'Natal/RN'),array(select value::uuid from jsonb_array_elements_text(col->'attachmentOfflineIds')));
elsif payload->>'availability'='scheduled' then
item:=payload->'schedule'; scheduled:=api.create_pickup_schedule(p_device_id,k,item||jsonb_build_object('schemaVersion',1,'clientId',c.id,'visitOfflineId',aggregate));
update api.pickup_schedules set report_id=v_report_id where id=(scheduled->>'id')::uuid;
end if;
result:=jsonb_build_object('eventId',event_id,'status','confirmed','canonicalId',v.id,'confirmedAt',stamp);
insert into private.sync_events(actor_id,device_id,event_id,idempotency_key,operation,schema_version,sequence,payload_hash,aggregate_type,aggregate_id,status,attempt_count,canonical_result,occurred_at,confirmed_at)
values(actor,p_device_id,event_id,k,'visit.scrap.saved.v1',1,seq,h,'visit',aggregate,'confirmed',1,result,(p_command->>'occurredAt')::timestamptz,stamp);
perform private.scrap_audit(actor,v_report_id,'visit.scrap.saved.v1',null,payload,k); return result;
exception when check_violation or not_null_violation or invalid_text_representation or invalid_datetime_format or foreign_key_violation then raise exception using errcode='P0001',message='VALIDATION_FAILED'; end $$;

create function api.list_scrap_operations() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare d jsonb:=private.resolve_current_identity(); cols jsonb; schedules jsonb; collected numeric; received numeric; estimated numeric; begin
if d is null or not(d->'capabilities' ?| array['scrap.read_operations','scrap.collect_self','scrap.schedule_self']) then raise exception using errcode='P0001',message='FORBIDDEN'; end if;
select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'offlineId',c.offline_id,
'client',jsonb_build_object('id',c.client_id,'name',c.client_name_snapshot,'address',c.address_snapshot),
'seller',jsonb_build_object('id',c.seller_id,'displayName',c.seller_name_snapshot),
'actualWeightKg',c.actual_weight_kg::text,'receiptNumber',c.receipt_number,'collectedAt',c.collected_at,'serverSavedAt',c.created_at,
'destinationType',c.destination_type,'concentrationPoint',case when c.concentration_point_id is null then null else jsonb_build_object('id',c.concentration_point_id,'name',c.destination_name_snapshot,'address',c.destination_address_snapshot) end,
'status',c.status,'version',c.version,'attachmentOfflineIds',to_jsonb(c.attachment_offline_ids),
'attachments',coalesce((select jsonb_agg(jsonb_build_object('offlineId',a.offline_id,'status',a.status) order by a.created_at) from api.scrap_attachments a where a.collection_id=c.id),'[]'::jsonb),
'receipt',case when r.id is null then null else jsonb_build_object('collectionId',c.id,'receivedWeightKg',r.received_weight_kg::text,'receivedLocation',r.received_location,'observation',r.observation,'receivedBy',jsonb_build_object('id',r.received_by,'displayName',r.receiver_name_snapshot),'receivedAt',r.received_at,'version',c.version) end,
'retentionUntil',c.retention_until) order by c.created_at desc),'[]'),coalesce(sum(c.actual_weight_kg),0),coalesce(sum(r.received_weight_kg),0)
into cols,collected,received from api.scrap_collections c left join api.scrap_receipts r on r.collection_id=c.id where private.scrap_visible(c.seller_id);
select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'offlineId',s.offline_id,
'client',jsonb_build_object('id',s.client_id,'name',s.client_name_snapshot,'address',s.address_snapshot),
'seller',jsonb_build_object('id',s.seller_id,'displayName',s.seller_name_snapshot),'origin',s.origin,'visitId',s.visit_id,
'estimatedWeightKg',s.estimated_weight_kg::text,'desiredDate',s.desired_date,'period',s.period,'observation',s.observation,'requestedAt',s.requested_at,'serverSavedAt',s.created_at,'status',s.status,'version',s.version) order by s.desired_date,s.period),'[]'),coalesce(sum(s.estimated_weight_kg),0)
into schedules,estimated from api.pickup_schedules s where private.scrap_visible(s.seller_id);
return jsonb_build_object('schemaVersion',1,'collections',cols,'schedules',schedules,'totals',jsonb_build_object('collectedKg',collected::text,'receivedKg',received::text,'scheduledKg',estimated::text)); end $$;

create function api.reserve_scrap_attachment(p_device_id uuid,p_idempotency_key uuid,p_command jsonb) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare d jsonb:=private.scrap_identity('scrap.collect_self'); actor uuid:=(d->>'id')::uuid; c api.scrap_collections%rowtype;
a api.scrap_attachments%rowtype; h text; v_id uuid:=gen_random_uuid(); v_offline uuid; begin
v_offline:=(p_command->>'offlineId')::uuid;
if p_device_id is null or p_idempotency_key is null or v_offline is null then raise exception using errcode='P0001',message='VALIDATION_FAILED'; end if;
select * into c from api.scrap_collections where seller_id=actor and device_id=p_device_id and offline_id=(p_command->>'collectionOfflineId')::uuid;
if not found or not(v_offline=any(c.attachment_offline_ids)) then raise exception using errcode='P0001',message='FORBIDDEN'; end if;
h:=encode(extensions.digest(convert_to(p_command::text,'UTF8'),'sha256'),'hex');
perform pg_advisory_xact_lock(hashtextextended(actor::text||':scrap-photo:'||v_offline,1));
select * into a from api.scrap_attachments where seller_id=actor and device_id=p_device_id and (offline_id=v_offline or reservation_key=p_idempotency_key);
if found then if a.reservation_hash<>h or a.offline_id<>v_offline then raise exception using errcode='P0001',message='IDEMPOTENCY_KEY_REUSED'; end if;
else
insert into api.scrap_attachments(id,offline_id,collection_id,seller_id,device_id,storage_path,content_type,byte_size,checksum,captured_at,reservation_key,reservation_hash)
values(v_id,v_offline,c.id,actor,p_device_id,'seller/'||actor||'/collection/'||c.id||'/'||v_id||case when p_command->>'contentType'='image/webp' then '.webp' else '.jpg' end,p_command->>'contentType',(p_command->>'byteSize')::integer,p_command->>'checksum',(p_command->>'capturedAt')::timestamptz,p_idempotency_key,h) returning * into a;
end if;
return jsonb_build_object('attachmentId',a.id,'offlineId',a.offline_id,'storagePath',a.storage_path,'status',a.status,'verifiedAt',a.verified_at);
exception when check_violation or not_null_violation or invalid_text_representation or invalid_datetime_format then raise exception using errcode='P0001',message='VALIDATION_FAILED'; end $$;
create function api.get_scrap_attachment_for_confirmation(p_device_id uuid,p_offline_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare d jsonb:=private.scrap_identity('scrap.collect_self'); a api.scrap_attachments%rowtype; begin
select * into a from api.scrap_attachments where seller_id=(d->>'id')::uuid and device_id=p_device_id and offline_id=p_offline_id;
if not found then raise exception using errcode='P0001',message='NOT_FOUND'; end if;
return jsonb_build_object('storagePath',a.storage_path,'contentType',a.content_type,'byteSize',a.byte_size,'checksum',a.checksum,'status',a.status); end $$;
create function api.confirm_scrap_attachment(p_device_id uuid,p_idempotency_key uuid,p_offline_id uuid,p_checksum text) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare d jsonb:=private.scrap_identity('scrap.collect_self'); actor uuid:=(d->>'id')::uuid; a api.scrap_attachments%rowtype; stamp timestamptz:=clock_timestamp(); begin
select * into a from api.scrap_attachments where seller_id=actor and device_id=p_device_id and offline_id=p_offline_id for update;
if not found then raise exception using errcode='P0001',message='NOT_FOUND'; end if;
if p_idempotency_key is null or a.checksum is distinct from p_checksum then raise exception using errcode='P0001',message='VALIDATION_FAILED'; end if;
-- Like visit evidence: the caller-scoped BFF downloads bytes and verifies digest before invoking this RPC.
if a.status<>'verified' then
update api.scrap_attachments set status='verified',verified_at=stamp,confirmation_key=p_idempotency_key,updated_at=stamp where id=a.id returning * into a;
update api.scrap_collections set last_event_at=stamp,retention_until=case when status='received' then stamp+interval '5 years' else null end,updated_at=stamp where id=a.collection_id;
perform private.scrap_audit(actor,a.collection_id,'scrap.attachment.verified.v1',null,jsonb_build_object('attachmentId',a.id,'checksum',a.checksum),p_idempotency_key);
end if;
return jsonb_build_object('schemaVersion',1,'offlineId',a.offline_id,'attachmentId',a.id,'status','verified','verifiedAt',a.verified_at); end $$;
create function api.list_scrap_evidence(p_collection_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare c api.scrap_collections%rowtype; begin select * into c from api.scrap_collections where id=p_collection_id;
if not found or not private.scrap_visible(c.seller_id) then raise exception using errcode='P0001',message='NOT_FOUND'; end if;
return coalesce((select jsonb_agg(jsonb_build_object('attachmentId',a.id,'offlineId',a.offline_id,'storagePath',a.storage_path,'contentType',a.content_type,'byteSize',a.byte_size,'checksum',a.checksum,'capturedAt',a.captured_at,'status',a.status,'verifiedAt',a.verified_at,'retentionUntil',c.retention_until) order by a.created_at) from api.scrap_attachments a where collection_id=c.id),'[]'); end $$;
create function private.can_access_scrap_attachment(p_path text,p_write boolean default false) returns boolean language plpgsql stable security definer set search_path='' as $$
declare d jsonb:=private.resolve_current_identity(); begin
return d is not null and exists(select 1 from api.scrap_attachments a where a.storage_path=p_path and
case when p_write then a.seller_id=(d->>'id')::uuid and d->'capabilities' ? 'scrap.collect_self' and a.status='reserved' else private.scrap_visible(a.seller_id) end); end $$;

create function api.confirm_scrap_receipt(p_collection_id uuid,p_idempotency_key uuid,p_command jsonb) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare d jsonb:=private.scrap_identity('scrap.receive'); actor uuid:=(d->>'id')::uuid; c api.scrap_collections%rowtype; h text; previous private.scrap_commands%rowtype;
stamp timestamptz:=clock_timestamp(); kg numeric; result jsonb; begin
kg:=(p_command->>'receivedWeightKg')::numeric;
if not(d->'roles' ? 'logistics') then raise exception using errcode='P0001',message='FORBIDDEN'; end if;
if p_idempotency_key is null or p_command->'schemaVersion' is distinct from '1'::jsonb then raise exception using errcode='P0001',message='VALIDATION_FAILED'; end if;
h:=encode(extensions.digest(convert_to(jsonb_build_object('collectionId',p_collection_id,'command',p_command)::text,'UTF8'),'sha256'),'hex');
perform pg_advisory_xact_lock(hashtextextended(actor::text||':receipt:'||p_idempotency_key,1));
select * into previous from private.scrap_commands where actor_id=actor and operation='receipt' and idempotency_key=p_idempotency_key;
if found then if previous.payload_hash<>h then raise exception using errcode='P0001',message='IDEMPOTENCY_KEY_REUSED'; end if; return previous.result; end if;
select * into c from api.scrap_collections where id=p_collection_id for update;
if not found then raise exception using errcode='P0001',message='NOT_FOUND'; end if;
if c.status<>'awaiting_receipt' or c.version is distinct from (p_command->>'expectedVersion')::integer then raise exception using errcode='P0001',message='VERSION_CONFLICT'; end if;
if exists(select 1 from unnest(c.attachment_offline_ids) x where not exists(select 1 from api.scrap_attachments a where a.collection_id=c.id and a.offline_id=x and a.status='verified')) then raise exception using errcode='P0001',message='ATTACHMENT_NOT_VERIFIED'; end if;
insert into api.scrap_receipts(collection_id,received_by,receiver_name_snapshot,received_weight_kg,difference_kg,received_location,observation,received_at)
values(c.id,actor,d->>'displayName',kg,kg-c.actual_weight_kg,trim(p_command->>'receivedLocation'),nullif(trim(p_command->>'observation'),''),stamp);
update api.scrap_collections set status='received',version=version+1,last_event_at=stamp,retention_until=stamp+interval '5 years',updated_at=stamp where id=c.id;
result:=jsonb_build_object('collectionId',c.id,'version',c.version+1,'receivedWeightKg',kg::text,'receivedLocation',trim(p_command->>'receivedLocation'),'observation',nullif(trim(p_command->>'observation'),''),'receivedAt',stamp,'receivedBy',jsonb_build_object('id',actor,'displayName',d->>'displayName'));
insert into private.scrap_commands(actor_id,operation,idempotency_key,payload_hash,result) values(actor,'receipt',p_idempotency_key,h,result);
perform private.scrap_audit(actor,c.id,'scrap.received.v1',to_jsonb(c),result,p_idempotency_key); return result;
exception when check_violation or not_null_violation or invalid_text_representation then raise exception using errcode='P0001',message='VALIDATION_FAILED'; end $$;

create function private.require_scrap_before_completion() returns trigger language plpgsql security definer set search_path='' as $$
declare r api.scrap_reports%rowtype; c api.scrap_collections%rowtype; begin
if new.status='completed' and old.status is distinct from 'completed' then
select * into r from api.scrap_reports where visit_id=new.id;
if not found then raise exception using errcode='P0001',message='VERSION_CONFLICT'; end if;
if r.availability='collected' then select * into c from api.scrap_collections where report_id=r.id;
if not found or exists(select 1 from unnest(c.attachment_offline_ids) x where not exists(select 1 from api.scrap_attachments a where a.collection_id=c.id and a.offline_id=x and a.status='verified')) then raise exception using errcode='P0001',message='ATTACHMENT_NOT_VERIFIED'; end if; end if; end if; return new; end $$;
create function private.prevent_scrap_history_delete() returns trigger language plpgsql set search_path='' as $$
begin raise exception using errcode='P0001',message='RETENTION_PROTECTED'; end $$;
-- No automatic destruction is enabled, including after the five-year minimum.
reset role;
do $protect$ declare t text; begin foreach t in array array['api.scrap_reports','api.scrap_collections','api.pickup_schedules','api.pickup_schedule_revisions','api.scrap_receipts','api.scrap_attachments','private.scrap_commands'] loop
execute format('create trigger protect_scrap_history before delete on %s for each row execute function private.prevent_scrap_history_delete()',t); end loop; end $protect$;
set local role cirne_visit_executor;
create trigger require_scrap_before_completion before update of status on api.visits for each row execute function private.require_scrap_before_completion();
reset role;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('scrap-evidence','scrap-evidence',false,2097152,array['image/jpeg','image/webp']);
create policy scrap_evidence_insert on storage.objects for insert to authenticated with check(bucket_id='scrap-evidence' and private.can_access_scrap_attachment(name,true));
create policy scrap_evidence_read on storage.objects for select to authenticated using(bucket_id='scrap-evidence' and private.can_access_scrap_attachment(name,false));
-- Destruction of this bucket's metadata is denied even to cleanup jobs; no expiry job is installed.
create function private.protect_scrap_storage_delete() returns trigger language plpgsql set search_path='' as $$
begin if old.bucket_id='scrap-evidence' then raise exception using errcode='P0001',message='RETENTION_PROTECTED'; end if; return old; end $$;
create trigger protect_scrap_storage_delete before delete on storage.objects for each row execute function private.protect_scrap_storage_delete();

set local role cirne_scrap_executor;
revoke all on function private.scrap_identity(text),private.scrap_visible(uuid),private.scrap_audit(uuid,uuid,text,jsonb,jsonb,uuid),private.sync_event(uuid,jsonb),private.require_scrap_before_completion(),private.prevent_scrap_history_delete() from public,anon,authenticated;
grant execute on function private.sync_event(uuid,jsonb),private.require_scrap_before_completion() to cirne_visit_executor;
grant execute on function private.sync_event(uuid,jsonb) to cirne_sync_executor;
revoke all on function private.can_access_scrap_attachment(text,boolean) from public,anon;
grant execute on function private.can_access_scrap_attachment(text,boolean) to authenticated;
do $rpc_acl$ declare f record; begin for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='api' and p.proowner=(select oid from pg_roles where rolname='cirne_scrap_executor') loop
execute format('revoke all on function %s from public,anon',f.signature); execute format('grant execute on function %s to authenticated',f.signature); end loop; end $rpc_acl$;
reset role;
revoke create on schema api,private from cirne_scrap_executor;
revoke create on schema private from cirne_sync_executor;
do $membership$ begin
execute format('revoke cirne_scrap_executor from %I granted by current_user',current_user);
execute format('revoke cirne_identity_executor from %I granted by current_user',current_user);
execute format('revoke cirne_route_executor from %I granted by current_user',current_user);
execute format('revoke cirne_visit_executor from %I granted by current_user',current_user);
execute format('revoke cirne_sync_executor from %I granted by current_user',current_user);
end $membership$;
comment on table api.scrap_collections is 'Actual seller-collected kg; awaiting receipt is retained indefinitely; closed cycles at least five years from last event. Never add receipt kg as new collection.';
comment on table api.pickup_schedules is 'Future estimated kg only, independent of visits. No execution or automatic completion in Story 3.10.';
commit;
