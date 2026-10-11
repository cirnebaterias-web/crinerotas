-- Preserve an offline scheduling intent at its capture date and expose only confirmed evidence.
begin;
do $membership$ begin
  execute format('grant cirne_scrap_executor to %I with set true granted by current_user', current_user);
end $membership$;
grant create on schema api to cirne_scrap_executor;
set local role cirne_scrap_executor;

create or replace function api.create_pickup_schedule(p_device_id uuid,p_idempotency_key uuid,p_command jsonb) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare d jsonb:=private.scrap_identity('scrap.schedule_self'); actor uuid:=(d->>'id')::uuid; h text; previous private.scrap_commands%rowtype;
c api.clients%rowtype; v api.visits%rowtype; r api.pickup_schedules%rowtype; result jsonb; requested_at timestamptz; begin
if p_device_id is null or p_idempotency_key is null or p_command->'schemaVersion' is distinct from '1'::jsonb then raise exception using errcode='P0001',message='VALIDATION_FAILED'; end if;
h:=encode(extensions.digest(convert_to(jsonb_build_object('deviceId',p_device_id,'command',p_command)::text,'UTF8'),'sha256'),'hex');
perform pg_advisory_xact_lock(hashtextextended(actor::text||':schedule:'||p_idempotency_key,1));
select * into previous from private.scrap_commands where actor_id=actor and operation='schedule' and idempotency_key=p_idempotency_key;
if found then if previous.payload_hash<>h then raise exception using errcode='P0001',message='IDEMPOTENCY_KEY_REUSED'; end if; return previous.result; end if;
select * into c from api.clients where id=(p_command->>'clientId')::uuid and status='active' and archived_at is null;
if not found then raise exception using errcode='P0001',message='NOT_FOUND'; end if;
if p_command->>'visitOfflineId' is not null then select * into v from api.visits where seller_id=actor and device_id=p_device_id and offline_id=(p_command->>'visitOfflineId')::uuid;
if not found or v.client_id<>c.id or v.status<>'in_progress' then raise exception using errcode='P0001',message='FORBIDDEN'; end if; end if;
requested_at:=(p_command->>'requestedAt')::timestamptz;
if requested_at is null or not isfinite(requested_at) or (p_command->>'desiredDate')::date <= (requested_at at time zone 'America/Sao_Paulo')::date then raise exception using errcode='P0001',message='VALIDATION_FAILED'; end if;
insert into api.pickup_schedules(offline_id,seller_id,device_id,visit_id,client_id,client_name_snapshot,address_snapshot,seller_name_snapshot,estimated_weight_kg,desired_date,period,observation,requested_at,origin)
values((p_command->>'offlineId')::uuid,actor,p_device_id,v.id,c.id,c.name,c.address,d->>'displayName',(p_command->>'estimatedWeightKg')::numeric,(p_command->>'desiredDate')::date,p_command->>'period',nullif(trim(p_command->>'observation'),''),requested_at,case when v.id is null then 'standalone' else 'visit' end) returning * into r;
result:=jsonb_build_object('id',r.id,'offlineId',r.offline_id,'client',jsonb_build_object('id',r.client_id,'name',r.client_name_snapshot,'address',r.address_snapshot),'seller',jsonb_build_object('id',actor,'displayName',r.seller_name_snapshot),'estimatedWeightKg',r.estimated_weight_kg::text,'desiredDate',r.desired_date,'period',r.period,'observation',r.observation,'requestedAt',r.requested_at,'origin',r.origin,'visitId',r.visit_id,'status',r.status,'version',r.version,'serverSavedAt',r.created_at);
insert into private.scrap_commands(actor_id,operation,idempotency_key,payload_hash,result) values(actor,'schedule',p_idempotency_key,h,result);
perform private.scrap_audit(actor,r.id,'scrap.schedule.created.v1',null,to_jsonb(r),p_idempotency_key); return result;
exception when check_violation or not_null_violation or invalid_text_representation or invalid_datetime_format or datetime_field_overflow or unique_violation then raise exception using errcode='P0001',message='VALIDATION_FAILED'; end $$;

create or replace function api.list_scrap_evidence(p_collection_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare c api.scrap_collections%rowtype; begin select * into c from api.scrap_collections where id=p_collection_id;
if not found or not private.scrap_visible(c.seller_id) then raise exception using errcode='P0001',message='NOT_FOUND'; end if;
return coalesce((select jsonb_agg(jsonb_build_object('attachmentId',a.id,'offlineId',a.offline_id,'storagePath',a.storage_path,'contentType',a.content_type,'byteSize',a.byte_size,'checksum',a.checksum,'capturedAt',a.captured_at,'status',a.status,'verifiedAt',a.verified_at,'retentionUntil',c.retention_until) order by a.created_at) from api.scrap_attachments a where a.collection_id=c.id and a.status='verified'),'[]'); end $$;
revoke all on function api.create_pickup_schedule(uuid,uuid,jsonb),api.list_scrap_evidence(uuid) from public,anon;
grant execute on function api.create_pickup_schedule(uuid,uuid,jsonb),api.list_scrap_evidence(uuid) to authenticated;

reset role;
revoke create on schema api from cirne_scrap_executor;
do $membership$ begin
  execute format('revoke cirne_scrap_executor from %I granted by current_user', current_user);
end $membership$;
commit;
