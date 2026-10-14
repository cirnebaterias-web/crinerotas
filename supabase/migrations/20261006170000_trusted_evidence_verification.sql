-- Verification authority is server-only after byte/hash validation. Caller JWT alone cannot assert verification.
-- Keep this migration ordered after the audit-retention migration with a valid UTC version.
begin;
do $membership$ begin
execute format('grant cirne_scrap_executor to %I with set true granted by current_user',current_user);
execute format('grant cirne_visit_executor to %I with set true granted by current_user',current_user);
end $membership$;
grant create on schema api to cirne_scrap_executor,cirne_visit_executor;
grant usage on schema storage to cirne_visit_executor;
grant select on storage.objects to cirne_visit_executor;
create policy visit_executor_verified_object_read on storage.objects for select to cirne_visit_executor using(bucket_id='visit-evidence');
set local role cirne_scrap_executor;
revoke all on function api.confirm_scrap_attachment(uuid,uuid,uuid,text) from public,anon,authenticated,service_role;
create function api.verify_scrap_attachment(p_seller_id uuid,p_device_id uuid,p_idempotency_key uuid,p_offline_id uuid,p_checksum text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare a api.scrap_attachments%rowtype; stamp timestamptz:=clock_timestamp(); begin
select * into a from api.scrap_attachments where seller_id=p_seller_id and device_id=p_device_id and offline_id=p_offline_id for update;
if not found then raise exception using errcode='P0001',message='FORBIDDEN'; end if;
if p_idempotency_key is null or a.checksum is distinct from p_checksum then raise exception using errcode='P0001',message='VALIDATION_FAILED'; end if;
if not exists(select 1 from storage.objects where bucket_id='scrap-evidence' and name=a.storage_path
and metadata->>'size' ~ '^[0-9]+$' and (metadata->>'size')::integer=a.byte_size
and metadata->>'mimetype'=a.content_type) then raise exception using errcode='P0001',message='ATTACHMENT_NOT_VERIFIED'; end if;
if a.status='verified' then
if a.confirmation_key is distinct from p_idempotency_key then raise exception using errcode='P0001',message='IDEMPOTENCY_KEY_REUSED'; end if;
else
update api.scrap_attachments set status='verified',verified_at=stamp,confirmation_key=p_idempotency_key,updated_at=stamp where id=a.id returning * into a;
update api.scrap_collections set last_event_at=greatest(last_event_at,stamp),retention_until=case when status='received' then greatest(retention_until,greatest(last_event_at,stamp)+interval '5 years') else null end,updated_at=stamp where id=a.collection_id;
perform private.scrap_audit(p_seller_id,a.collection_id,'scrap.attachment.verified.v1',null,jsonb_build_object('attachmentId',a.id,'checksum',a.checksum),p_idempotency_key);
end if;
return jsonb_build_object('schemaVersion',1,'offlineId',a.offline_id,'attachmentId',a.id,'status','verified','verifiedAt',a.verified_at); end $$;
revoke all on function api.verify_scrap_attachment(uuid,uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function api.verify_scrap_attachment(uuid,uuid,uuid,uuid,text) to service_role;
reset role;
set local role cirne_visit_executor;
revoke all on function api.confirm_visit_attachment(uuid,uuid,uuid,text) from public,anon,authenticated,service_role;
create function api.verify_visit_attachment(p_seller_id uuid,p_device_id uuid,p_idempotency_key uuid,p_offline_id uuid,p_checksum text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare a api.visit_attachments%rowtype; stamp timestamptz:=clock_timestamp(); begin
select * into a from api.visit_attachments where seller_id=p_seller_id and device_id=p_device_id and offline_id=p_offline_id for update;
if not found then raise exception using errcode='P0001',message='FORBIDDEN'; end if;
if p_idempotency_key is null or a.checksum is distinct from p_checksum then raise exception using errcode='P0001',message='VALIDATION_FAILED'; end if;
if not exists(select 1 from storage.objects where bucket_id='visit-evidence' and name=a.storage_path
and metadata->>'size' ~ '^[0-9]+$' and (metadata->>'size')::integer=a.byte_size
and metadata->>'mimetype'=a.content_type) then raise exception using errcode='P0001',message='ATTACHMENT_NOT_VERIFIED'; end if;
if a.status='verified' then
if a.confirmation_key is distinct from p_idempotency_key then raise exception using errcode='P0001',message='IDEMPOTENCY_KEY_REUSED'; end if;
else
update api.visit_attachments set status='verified',verified_at=stamp,confirmation_key=p_idempotency_key,updated_at=stamp where id=a.id returning * into a;
end if;
return jsonb_build_object('schemaVersion',1,'offlineId',a.offline_id,'attachmentId',a.id,'status','verified','verifiedAt',a.verified_at); end $$;
revoke all on function api.verify_visit_attachment(uuid,uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function api.verify_visit_attachment(uuid,uuid,uuid,uuid,text) to service_role;
reset role;
revoke create on schema api from cirne_scrap_executor,cirne_visit_executor;
do $membership$ begin
execute format('revoke cirne_scrap_executor from %I granted by current_user',current_user);
execute format('revoke cirne_visit_executor from %I granted by current_user',current_user);
end $membership$;
commit;
