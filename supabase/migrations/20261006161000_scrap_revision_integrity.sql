-- Story 3.10: immutable originals, append-only revisions and evidence object guard.
begin;
do $membership$ begin execute format('grant cirne_scrap_executor to %I with set true granted by current_user',current_user); end $membership$;
grant create on schema api,private to cirne_scrap_executor;
grant usage on schema storage to cirne_scrap_executor;
grant select on storage.objects to cirne_scrap_executor;
create policy scrap_executor_storage_read on storage.objects for select to cirne_scrap_executor using(bucket_id='scrap-evidence');
set local role cirne_scrap_executor;
create function api.revise_pickup_schedule(p_schedule_id uuid,p_idempotency_key uuid,p_command jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare d jsonb:=private.scrap_identity('scrap.read_operations'); actor uuid:=(d->>'id')::uuid; s api.pickup_schedules%rowtype;
updated api.pickup_schedules%rowtype; previous private.scrap_commands%rowtype; h text; result jsonb; stamp timestamptz:=clock_timestamp(); begin
if p_idempotency_key is null or p_command->'schemaVersion' is distinct from '1'::jsonb or length(trim(p_command->>'reason')) not between 1 and 500 then raise exception using errcode='P0001',message='VALIDATION_FAILED'; end if;
h:=encode(extensions.digest(convert_to(jsonb_build_object('scheduleId',p_schedule_id,'command',p_command)::text,'UTF8'),'sha256'),'hex');
perform pg_advisory_xact_lock(hashtextextended(actor::text||':schedule-revision:'||p_idempotency_key,1));
select * into previous from private.scrap_commands where actor_id=actor and operation='schedule_revision' and idempotency_key=p_idempotency_key;
if found then if previous.payload_hash<>h then raise exception using errcode='P0001',message='IDEMPOTENCY_KEY_REUSED'; end if; return previous.result; end if;
select * into s from api.pickup_schedules where id=p_schedule_id for update;
if not found or not private.scrap_visible(s.seller_id) then raise exception using errcode='P0001',message='NOT_FOUND'; end if;
if s.version is distinct from (p_command->>'expectedVersion')::integer then raise exception using errcode='P0001',message='VERSION_CONFLICT'; end if;
if (p_command->>'desiredDate')::date <= (clock_timestamp() at time zone 'America/Sao_Paulo')::date then raise exception using errcode='P0001',message='VALIDATION_FAILED'; end if;
update api.pickup_schedules set estimated_weight_kg=(p_command->>'estimatedWeightKg')::numeric,
desired_date=(p_command->>'desiredDate')::date,period=p_command->>'period',observation=nullif(trim(p_command->>'observation'),''),
version=version+1,last_event_at=stamp,updated_at=stamp where id=s.id returning * into updated;
insert into api.pickup_schedule_revisions(schedule_id,actor_id,reason,before_data,after_data)
values(s.id,actor,trim(p_command->>'reason'),to_jsonb(s),to_jsonb(updated));
result:=jsonb_build_object('id',updated.id,'offlineId',updated.offline_id,
'client',jsonb_build_object('id',updated.client_id,'name',updated.client_name_snapshot,'address',updated.address_snapshot),
'seller',jsonb_build_object('id',updated.seller_id,'displayName',updated.seller_name_snapshot),
'origin',updated.origin,'visitId',updated.visit_id,'estimatedWeightKg',updated.estimated_weight_kg::text,'desiredDate',updated.desired_date,
'period',updated.period,'observation',updated.observation,'requestedAt',updated.requested_at,'serverSavedAt',updated.created_at,'status',updated.status,'version',updated.version);
insert into private.scrap_commands(actor_id,operation,idempotency_key,payload_hash,result) values(actor,'schedule_revision',p_idempotency_key,h,result);
perform private.scrap_audit(actor,s.id,'scrap.schedule.revised.v1',to_jsonb(s),to_jsonb(updated),p_idempotency_key); return result;
exception when check_violation or not_null_violation or invalid_text_representation or invalid_datetime_format then raise exception using errcode='P0001',message='VALIDATION_FAILED'; end $$;
revoke all on function api.revise_pickup_schedule(uuid,uuid,jsonb) from public,anon;
grant execute on function api.revise_pickup_schedule(uuid,uuid,jsonb) to authenticated;
create function private.guard_scrap_attachment_verification() returns trigger language plpgsql security definer set search_path='' as $$
begin
if new.status='verified' and old.status='reserved' and not exists(select 1 from storage.objects o
where o.bucket_id='scrap-evidence' and o.name=new.storage_path and (o.metadata->>'size')::integer=new.byte_size) then
raise exception using errcode='P0001',message='ATTACHMENT_NOT_VERIFIED'; end if; return new; end $$;
create function private.guard_scrap_immutable_row() returns trigger language plpgsql set search_path='' as $$
begin raise exception using errcode='P0001',message='HISTORY_IMMUTABLE'; end $$;
create function private.guard_scrap_collection_original() returns trigger language plpgsql set search_path='' as $$
begin if (to_jsonb(new)-array['status','version','last_event_at','retention_until','updated_at']) is distinct from
(to_jsonb(old)-array['status','version','last_event_at','retention_until','updated_at']) then
raise exception using errcode='P0001',message='HISTORY_IMMUTABLE'; end if; return new; end $$;
revoke all on function private.guard_scrap_attachment_verification(),private.guard_scrap_immutable_row(),private.guard_scrap_collection_original() from public,anon,authenticated;
reset role;
create trigger guard_scrap_attachment_verification before update of status on api.scrap_attachments for each row execute function private.guard_scrap_attachment_verification();
create trigger guard_scrap_collection_original before update on api.scrap_collections for each row execute function private.guard_scrap_collection_original();
create trigger immutable_scrap_receipts before update on api.scrap_receipts for each row execute function private.guard_scrap_immutable_row();
create trigger immutable_scrap_revisions before update on api.pickup_schedule_revisions for each row execute function private.guard_scrap_immutable_row();
create trigger immutable_scrap_commands before update on private.scrap_commands for each row execute function private.guard_scrap_immutable_row();
revoke create on schema api,private from cirne_scrap_executor;
do $membership$ begin execute format('revoke cirne_scrap_executor from %I granted by current_user',current_user); end $membership$;
commit;
