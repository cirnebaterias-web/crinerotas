-- Story 3.10 AC9/14: authorized corrections retain every earlier business value.
begin;
insert into api.role_permissions(role_id,permission_code) values
('00000000-0000-4000-8000-000000000002','scrap.manage_operations'),
('00000000-0000-4000-8000-000000000003','scrap.manage_operations');
do $membership$ begin
execute format('grant cirne_scrap_executor to %I with set true granted by current_user',current_user);
execute format('grant cirne_sync_executor to %I with set true granted by current_user',current_user);
end $membership$;
set local role cirne_sync_executor;
grant select on private.audit_events to cirne_scrap_executor;
reset role;
create table api.scrap_corrections(
id uuid primary key default gen_random_uuid(),collection_id uuid not null references api.scrap_collections(id) on delete restrict,
kind text not null check(kind in('collection','receipt')),actor_id uuid not null references api.user_profiles(id) on delete restrict,
reason text not null check(length(trim(reason)) between 1 and 500),before_data jsonb not null,after_data jsonb not null,
created_at timestamptz not null default now(),updated_at timestamptz not null default now());
create index scrap_corrections_collection_time on api.scrap_corrections(collection_id,created_at);
alter table api.scrap_corrections enable row level security;
alter table api.scrap_corrections force row level security;
create policy scrap_corrections_executor on api.scrap_corrections for all to cirne_scrap_executor using(true) with check(true);
revoke all on api.scrap_corrections from public,anon,authenticated;
grant select,insert on api.scrap_corrections to cirne_scrap_executor;
grant create on schema api,private to cirne_scrap_executor;
set local role cirne_scrap_executor;
create or replace function private.guard_scrap_collection_original() returns trigger language plpgsql set search_path='' as $$
declare allowed text[]:=array['status','version','last_event_at','retention_until','updated_at']; begin
if current_user='cirne_scrap_executor' and current_setting('cirne.scrap_correction',true)='true' then
allowed:=allowed||array['actual_weight_kg','collected_at','receipt_number','destination_type','concentration_point_id','destination_name_snapshot','destination_address_snapshot']; end if;
if (to_jsonb(new)-allowed) is distinct from (to_jsonb(old)-allowed) then raise exception using errcode='P0001',message='HISTORY_IMMUTABLE'; end if; return new; end $$;
create or replace function private.guard_scrap_immutable_row() returns trigger language plpgsql set search_path='' as $$
begin
if tg_table_name='scrap_receipts' and current_user='cirne_scrap_executor' and current_setting('cirne.scrap_correction',true)='true'
and (to_jsonb(new)-array['received_weight_kg','difference_kg','received_location','observation','updated_at']) is not distinct from
(to_jsonb(old)-array['received_weight_kg','difference_kg','received_location','observation','updated_at']) then return new; end if;
raise exception using errcode='P0001',message='HISTORY_IMMUTABLE'; end $$;
-- BEGIN correction function
create or replace function private.correct_scrap(p_kind text,p_collection_id uuid,p_idempotency_key uuid,p_command jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare d jsonb:=private.scrap_identity('scrap.manage_operations'); actor uuid:=(d->>'id')::uuid;
c api.scrap_collections%rowtype; r api.scrap_receipts%rowtype; point api.scrap_concentration_points%rowtype;
previous private.scrap_commands%rowtype; h text; before_doc jsonb; after_doc jsonb; result jsonb;
stamp timestamptz:=clock_timestamp(); old_flag text:=coalesce(current_setting('cirne.scrap_correction',true),'false');
new_kg numeric; note text; action text:='scrap.'||p_kind||'.revised.v1'; begin
if not(d->'roles' ?| array['manager','administrator']) then raise exception using errcode='P0001',message='FORBIDDEN'; end if;
if p_idempotency_key is null or p_command->'schemaVersion' is distinct from '1'::jsonb or
p_command->>'reason' is null or length(trim(p_command->>'reason')) not between 1 and 500 then raise exception using errcode='P0001',message='VALIDATION_FAILED'; end if;
h:=encode(extensions.digest(convert_to(jsonb_build_object('collectionId',p_collection_id,'command',p_command)::text,'UTF8'),'sha256'),'hex');
perform pg_advisory_xact_lock(hashtextextended(actor::text||':'||action||':'||p_idempotency_key,1));
select * into previous from private.scrap_commands where actor_id=actor and operation=action and idempotency_key=p_idempotency_key;
if found then if previous.payload_hash<>h then raise exception using errcode='P0001',message='IDEMPOTENCY_KEY_REUSED'; end if; return previous.result; end if;
select * into c from api.scrap_collections where id=p_collection_id for update;
if not found or not private.scrap_visible(c.seller_id) then raise exception using errcode='P0001',message='NOT_FOUND'; end if;
if c.version is distinct from (p_command->>'expectedVersion')::integer then raise exception using errcode='P0001',message='VERSION_CONFLICT'; end if;
select * into r from api.scrap_receipts where collection_id=c.id;
select x into before_doc from jsonb_array_elements(api.list_scrap_operations()->'collections') x where x->>'id'=c.id::text;
perform set_config('cirne.scrap_correction','true',true);
if p_kind='collection' then
new_kg:=(p_command->>'actualWeightKg')::numeric;
if (p_command->>'collectedAt')::timestamptz>stamp then raise exception using errcode='P0001',message='VALIDATION_FAILED'; end if;
if p_command->>'destinationType'='concentration_point' then
if c.destination_type='concentration_point' and c.concentration_point_id=(p_command->>'concentrationPointId')::uuid then
point.id:=c.concentration_point_id;point.name:=c.destination_name_snapshot;point.address:=c.destination_address_snapshot;
else select * into point from api.scrap_concentration_points where id=(p_command->>'concentrationPointId')::uuid and active;
if not found then raise exception using errcode='P0001',message='VALIDATION_FAILED'; end if; end if;
elsif p_command->>'destinationType' is distinct from 'headquarters' or p_command->>'concentrationPointId' is not null then raise exception using errcode='P0001',message='VALIDATION_FAILED'; end if;
if r.id is not null then
note:=coalesce(nullif(trim(p_command->>'divergenceObservation'),''),r.observation);
if new_kg is distinct from r.received_weight_kg and (note is null or length(trim(note))=0) then raise exception using errcode='P0001',message='VALIDATION_FAILED'; end if;
update api.scrap_receipts set difference_kg=received_weight_kg-new_kg,observation=note,updated_at=stamp where id=r.id;
end if;
update api.scrap_collections set actual_weight_kg=new_kg,collected_at=(p_command->>'collectedAt')::timestamptz,
receipt_number=trim(p_command->>'receiptNumber'),destination_type=p_command->>'destinationType',concentration_point_id=point.id,
destination_name_snapshot=coalesce(point.name,'Matriz Cirne — Natal'),destination_address_snapshot=coalesce(point.address,'Natal/RN'),
version=version+1,last_event_at=greatest(last_event_at,stamp),retention_until=case when status='received' then greatest(retention_until,greatest(last_event_at,r.received_at,stamp)+interval '5 years') else null end,updated_at=stamp where id=c.id;
elsif p_kind='receipt' then
if r.id is null then raise exception using errcode='P0001',message='VERSION_CONFLICT'; end if;
new_kg:=(p_command->>'receivedWeightKg')::numeric; note:=nullif(trim(p_command->>'observation'),'');
if new_kg is distinct from c.actual_weight_kg and note is null then raise exception using errcode='P0001',message='VALIDATION_FAILED'; end if;
update api.scrap_receipts set received_weight_kg=new_kg,difference_kg=new_kg-c.actual_weight_kg,
received_location=trim(p_command->>'receivedLocation'),observation=note,updated_at=stamp where id=r.id;
update api.scrap_collections set version=version+1,last_event_at=greatest(last_event_at,stamp),retention_until=greatest(retention_until,greatest(last_event_at,r.received_at,stamp)+interval '5 years'),updated_at=stamp where id=c.id;
else raise exception using errcode='P0001',message='VALIDATION_FAILED'; end if;
perform set_config('cirne.scrap_correction',old_flag,true);
select x into after_doc from jsonb_array_elements(api.list_scrap_operations()->'collections') x where x->>'id'=c.id::text;
result:=case when p_kind='collection' then after_doc else after_doc->'receipt' end;
insert into api.scrap_corrections(collection_id,kind,actor_id,reason,before_data,after_data,created_at,updated_at)
values(c.id,p_kind,actor,trim(p_command->>'reason'),before_doc,after_doc,stamp,stamp);
insert into private.audit_events(actor_id,target_type,target_id,action,before_data,after_data,reason,origin,request_id,occurred_at)
values(actor,'scrap',c.id,action,before_doc,after_doc,trim(p_command->>'reason'),'system',p_idempotency_key,stamp);
insert into private.scrap_commands(actor_id,operation,idempotency_key,payload_hash,result) values(actor,action,p_idempotency_key,h,result);
return result;
exception when check_violation or not_null_violation or invalid_text_representation or invalid_datetime_format then raise exception using errcode='P0001',message='VALIDATION_FAILED'; end $$;
-- END correction function
create function api.revise_scrap_collection(p_collection_id uuid,p_idempotency_key uuid,p_command jsonb)
returns jsonb language sql volatile security definer set search_path='' as $$ select private.correct_scrap('collection',p_collection_id,p_idempotency_key,p_command); $$;
create function api.revise_scrap_receipt(p_collection_id uuid,p_idempotency_key uuid,p_command jsonb)
returns jsonb language sql volatile security definer set search_path='' as $$ select private.correct_scrap('receipt',p_collection_id,p_idempotency_key,p_command); $$;
create function api.list_scrap_audit(p_collection_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare c api.scrap_collections%rowtype; begin
select * into c from api.scrap_collections where id=p_collection_id;
if not found or not private.scrap_visible(c.seller_id) then raise exception using errcode='P0001',message='NOT_FOUND'; end if;
return coalesce((select jsonb_agg(jsonb_build_object('id',q.id,'action',q.action,'actor',jsonb_build_object('id',q.actor_id,'displayName',p.display_name),
'occurredAt',q.occurred_at,'reason',q.reason,'before',q.before_data,'after',q.after_data) order by q.occurred_at,q.id)
from (
select a.id,a.action,a.actor_id,a.occurred_at,a.reason,null::jsonb before_data,
case when a.action='visit.scrap.saved.v1' then a.after_data->'collection' else a.after_data end after_data
from private.audit_events a where (a.target_id=c.report_id and a.action='visit.scrap.saved.v1') or (a.target_id=c.id and a.action='scrap.received.v1')
union all select r.id,'scrap.'||r.kind||'.revised.v1',r.actor_id,r.created_at,r.reason,r.before_data,r.after_data
from api.scrap_corrections r where r.collection_id=c.id
) q join api.user_profiles p on p.id=q.actor_id),'[]'); end $$;
revoke all on function private.correct_scrap(text,uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function api.revise_scrap_collection(uuid,uuid,jsonb),api.revise_scrap_receipt(uuid,uuid,jsonb),api.list_scrap_audit(uuid) from public,anon;
grant execute on function api.revise_scrap_collection(uuid,uuid,jsonb),api.revise_scrap_receipt(uuid,uuid,jsonb),api.list_scrap_audit(uuid) to authenticated;
reset role;
create trigger protect_scrap_corrections before delete on api.scrap_corrections for each row execute function private.prevent_scrap_history_delete();
create trigger immutable_scrap_corrections before update on api.scrap_corrections for each row execute function private.guard_scrap_immutable_row();
revoke create on schema api,private from cirne_scrap_executor;
do $membership$ begin
execute format('revoke cirne_scrap_executor from %I granted by current_user',current_user);
execute format('revoke cirne_sync_executor from %I granted by current_user',current_user);
end $membership$;
commit;
