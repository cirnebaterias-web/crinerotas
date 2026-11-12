begin;

do $membership$ begin
  execute pg_catalog.format('grant cirne_administration_executor to %I with set true granted by current_user', current_user);
end $membership$;

grant insert on api.user_profiles to cirne_administration_executor;
grant create on schema api to cirne_administration_executor;
set local role cirne_administration_executor;

create function api.create_administration_user(p_user_id uuid, p_command jsonb, p_origin text default 'web')
returns jsonb language plpgsql volatile security definer set search_path = '' as $function$
declare
  identity_document jsonb := private.administration_identity();
  v_actor_id uuid := (identity_document->>'id')::uuid;
  key_value uuid;
  payload_hash text;
  existing private.administration_commands%rowtype;
  result_document jsonb;
begin
  if p_user_id is null or p_origin not in ('web','cli') or jsonb_typeof(p_command) <> 'object'
     or (select count(*) from jsonb_object_keys(p_command)) <> 5
     or not p_command ?& array['schemaVersion','displayName','roles','reason','idempotencyKey']
     or p_command->>'schemaVersion' <> '1'
     or char_length(btrim(p_command->>'displayName')) not between 2 and 120
     or jsonb_typeof(p_command->'roles') <> 'array'
     or jsonb_array_length(p_command->'roles') not between 1 and 4
     or char_length(btrim(p_command->>'reason')) not between 10 and 500
     or (p_command->>'idempotencyKey') !~ '^[0-9a-fA-F-]{36}$' then
    raise exception using errcode='P0001', message='VALIDATION_FAILED';
  end if;
  if exists (select 1 from jsonb_array_elements_text(p_command->'roles') requested
    where not exists (select 1 from api.roles role_row where role_row.code=requested)) then
    raise exception using errcode='P0001', message='VALIDATION_FAILED';
  end if;
  key_value := (p_command->>'idempotencyKey')::uuid;
  payload_hash := encode(extensions.digest(convert_to(jsonb_build_object(
    'userId',p_user_id,'command',p_command)::text,'UTF8'),'sha256'),'hex');
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    v_actor_id::text||':identity.user.provisioned.v1:'||key_value::text,0));
  select * into existing from private.administration_commands command
    where command.actor_id=v_actor_id and command.idempotency_key=key_value;
  if found then
    if existing.payload_hash<>payload_hash then
      raise exception using errcode='P0001', message='IDEMPOTENCY_KEY_REUSED';
    end if;
    return jsonb_set(existing.canonical_result,'{replayed}','true'::jsonb);
  end if;
  if exists(select 1 from api.user_profiles where id=p_user_id) then
    raise exception using errcode='P0001', message='VERSION_CONFLICT';
  end if;
  insert into api.user_profiles(id,display_name) values(p_user_id,btrim(p_command->>'displayName'));
  insert into api.user_role_assignments(user_id,role_id,assigned_by)
    select p_user_id,role_row.id,v_actor_id from api.roles role_row
    where p_command->'roles' ? role_row.code;
  insert into private.audit_events(actor_id,target_type,target_id,action,before_data,after_data,reason,origin,request_id)
    values(v_actor_id,'user_profile',p_user_id,'identity.user.provisioned.v1',null,
      private.administration_user_document(p_user_id),btrim(p_command->>'reason'),p_origin,key_value);
  result_document:=jsonb_build_object('schemaVersion',1,'replayed',false,
    'user',private.administration_user_document(p_user_id));
  insert into private.administration_commands(actor_id,idempotency_key,payload_hash,target_user_id,canonical_result)
    values(v_actor_id,key_value,payload_hash,p_user_id,result_document);
  return result_document;
exception when foreign_key_violation then
  raise exception using errcode='P0001', message='NOT_FOUND';
end $function$;

create function api.record_administration_password_reset(p_user_id uuid, p_command jsonb, p_origin text default 'web')
returns jsonb language plpgsql volatile security definer set search_path = '' as $function$
declare
  identity_document jsonb := private.administration_identity();
  v_actor_id uuid := (identity_document->>'id')::uuid;
  key_value uuid;
  payload_hash text;
  existing private.administration_commands%rowtype;
  result_document jsonb;
begin
  if p_user_id is null or p_user_id=v_actor_id or p_origin not in ('web','cli')
     or jsonb_typeof(p_command)<>'object' or (select count(*) from jsonb_object_keys(p_command))<>3
     or not p_command ?& array['schemaVersion','reason','idempotencyKey']
     or p_command->>'schemaVersion'<>'1' or char_length(btrim(p_command->>'reason')) not between 10 and 500
     or (p_command->>'idempotencyKey') !~ '^[0-9a-fA-F-]{36}$' then
    raise exception using errcode='P0001', message='VALIDATION_FAILED';
  end if;
  if not exists(select 1 from api.user_profiles where id=p_user_id) then
    raise exception using errcode='P0001', message='NOT_FOUND';
  end if;
  key_value:=(p_command->>'idempotencyKey')::uuid;
  payload_hash:=encode(extensions.digest(convert_to(jsonb_build_object(
    'userId',p_user_id,'command',p_command)::text,'UTF8'),'sha256'),'hex');
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    v_actor_id::text||':identity.password.reset.v1:'||key_value::text,0));
  select * into existing from private.administration_commands command
    where command.actor_id=v_actor_id and command.idempotency_key=key_value;
  if found then
    if existing.payload_hash<>payload_hash then raise exception using errcode='P0001',message='IDEMPOTENCY_KEY_REUSED'; end if;
    return jsonb_set(existing.canonical_result,'{replayed}','true'::jsonb);
  end if;
  insert into private.audit_events(actor_id,target_type,target_id,action,before_data,after_data,reason,origin,request_id)
    values(v_actor_id,'user_profile',p_user_id,'identity.password.reset.v1',null,
      jsonb_build_object('credentialState','temporary_password_set'),btrim(p_command->>'reason'),p_origin,key_value);
  result_document:=jsonb_build_object('schemaVersion',1,'replayed',false,'userId',p_user_id);
  insert into private.administration_commands(actor_id,idempotency_key,payload_hash,target_user_id,canonical_result)
    values(v_actor_id,key_value,payload_hash,p_user_id,result_document);
  return result_document;
end $function$;

revoke all on function api.create_administration_user(uuid,jsonb,text),
  api.record_administration_password_reset(uuid,jsonb,text) from public,anon,authenticated;
grant execute on function api.create_administration_user(uuid,jsonb,text),
  api.record_administration_password_reset(uuid,jsonb,text) to authenticated;
revoke create on schema api from cirne_administration_executor;
reset role;

do $membership$ begin
  execute pg_catalog.format('revoke cirne_administration_executor from %I granted by current_user', current_user);
end $membership$;
commit;
