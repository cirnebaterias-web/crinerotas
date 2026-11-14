begin;

do $preflight$
begin
  if to_regclass('api.client_classifications') is not null
     or to_regclass('api.route_stop_attempts') is not null then
    raise exception 'Field outcome foundation is already installed';
  end if;
  if to_regclass('api.client_seller_scopes') is null
     or to_regclass('api.visit_attachments') is null then
    raise exception 'Field outcome foundation requires portfolio and evidence foundations';
  end if;
end
$preflight$;

insert into api.role_permissions (role_id, permission_code)
values
  ('00000000-0000-4000-8000-000000000001', 'client.classify_self'),
  ('00000000-0000-4000-8000-000000000001', 'client.close_self'),
  ('00000000-0000-4000-8000-000000000001', 'route.extend_self'),
  ('00000000-0000-4000-8000-000000000001', 'route.attempt_self'),
  ('00000000-0000-4000-8000-000000000002', 'client.classify_scoped'),
  ('00000000-0000-4000-8000-000000000002', 'client.close_scoped')
on conflict (role_id, permission_code) do nothing;

-- Membership permits altering legacy objects owned by the runtime role, while
-- objects remain created by the migration owner (the executor has no CREATE).
do $ownership$
begin
  execute pg_catalog.format('grant cirne_route_executor to %I with set true granted by current_user',current_user);
  execute pg_catalog.format('grant usage on schema private to %I',current_user);
end
$ownership$;

create table api.client_classifications (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[a-z][a-z0-9_]{1,63}$'),
  label text not null check (char_length(btrim(label)) between 1 and 80),
  description text not null check (char_length(btrim(description)) between 1 and 500),
  display_order smallint not null unique check (display_order between 1 and 13),
  published boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into api.client_classifications (id, code, label, description, display_order) values
('43000000-0000-4000-8000-000000000001','acessorios_automotivos','ACESSÓRIOS AUTOMOTIVOS','Generalista em peças automotivas. Bateria não é tão representativa. Grande variedade de produtos. Estoque menor e menos diversidade de marcas de baterias.',1),
('43000000-0000-4000-8000-000000000002','autoeletricas','AUTOELÉTRICAS','Especialista em elétrica. Foco em baterias e serviços. Variedade de produtos e serviços elétricos em geral. Menor variedade e estoque de marcas.',2),
('43000000-0000-4000-8000-000000000003','autopecas','AUTOPEÇAS','Generalista em peças automotivas. Bateria não é tão representativa. Grande variedade de produtos. Estoque menor e menos diversidade de marcas de baterias.',3),
('43000000-0000-4000-8000-000000000004','casa_de_baterias','CASA DE BATERIAS','Especialista em baterias. Foco em troca de baterias. Grande variedade de estoque de marcas e modelos de baterias. Pode atender pequenas lojas do varejo na região.',4),
('43000000-0000-4000-8000-000000000005','centro_automotivo','CENTRO AUTOMOTIVO','Generalista em serviços automotivos. Bateria não é tão representativa. Grande variedade de produtos. Estoque menor e menos diversidade de marcas de baterias.',5),
('43000000-0000-4000-8000-000000000006','concessionarias','CONCESSIONÁRIAS','Generalista em peças automotivas. Bateria não é tão representativa. Grande variedade de produtos. Estoque menor e menos diversidade de marcas de baterias.',6),
('43000000-0000-4000-8000-000000000007','frotista','FROTISTA','Clientes que compram baterias para a frota de sua empresa. Não utilizam o produto para revenda, somente para frota própria.',7),
('43000000-0000-4000-8000-000000000008','generalista','GENERALISTA','Agropecuária, posto de combustível e outros tipos de mercados que revendem baterias, mas não têm baterias como atividade principal.',8),
('43000000-0000-4000-8000-000000000009','loja_lubrificantes_pneus','LOJA DE LUBRIFICANTES E PNEUS','Generalista em serviços automotivos. Bateria não é tão representativa. Grande variedade de produtos. Estoque menor e menos diversidade de marcas de baterias.',9),
('43000000-0000-4000-8000-000000000010','oficina_mecanica','OFICINA MECÂNICA','Generalista em serviços automotivos. Bateria não é tão representativa. Grande variedade de produtos. Estoque menor e menos diversidade de marcas de baterias.',10),
('43000000-0000-4000-8000-000000000011','outros','OUTROS','Não se encaixam em nenhuma classificação de atacado ou revenda.',11),
('43000000-0000-4000-8000-000000000012','delivery','DELIVERY','Cliente que compra por telefone, não tem loja física e não trabalha com estoque.',12),
('43000000-0000-4000-8000-000000000013','consumidor','CONSUMIDOR','Varejo, CPF ou CNPJ.',13);

alter table api.clients
  add column classification_id uuid references api.client_classifications(id) on delete restrict,
  add column classified_by uuid references api.user_profiles(id) on delete restrict,
  add column classified_at timestamptz,
  add column operating_status text not null default 'active' check (operating_status in ('active','closed')),
  add column operating_closed_reason text,
  add column operating_closed_observation text,
  add column operating_closed_by uuid references api.user_profiles(id) on delete restrict,
  add column operating_closed_at timestamptz,
  add constraint clients_classification_shape_check check (
    (classification_id is null and classified_by is null and classified_at is null)
    or (classification_id is not null and classified_by is not null and classified_at is not null)
  ),
  add constraint clients_operating_status_shape_check check (
    (operating_status = 'active' and operating_closed_reason is null and operating_closed_observation is null
      and operating_closed_by is null and operating_closed_at is null)
    or (operating_status = 'closed' and char_length(btrim(operating_closed_reason)) between 1 and 120
      and (operating_closed_observation is null or char_length(btrim(operating_closed_observation)) between 1 and 500)
      and operating_closed_by is not null and operating_closed_at is not null)
  );
create index clients_classification_idx on api.clients (classification_id) where classification_id is not null;
create index clients_operating_active_idx on api.clients (id) where operating_status = 'active';

alter table api.route_version_stops
  add column source text not null default 'planned' check (source in ('planned','seller_ad_hoc'));

create table api.route_stop_version_lineage (
  previous_route_version_stop_id uuid primary key references api.route_version_stops(id) on delete restrict,
  successor_route_version_stop_id uuid not null unique references api.route_version_stops(id) on delete restrict,
  previous_execution_id uuid not null unique references api.route_stop_executions(id) on delete restrict,
  successor_execution_id uuid not null unique references api.route_stop_executions(id) on delete restrict,
  migrated_at timestamptz not null default now()
);

create table api.route_stop_attempt_reasons (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  label text not null check (char_length(btrim(label)) between 1 and 120),
  display_order smallint not null unique check (display_order between 1 and 9),
  published boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
insert into api.route_stop_attempt_reasons (id,code,label,display_order) values
('46000000-0000-4000-8000-000000000001','client_closed','Cliente fechado',1),
('46000000-0000-4000-8000-000000000002','responsible_absent','Responsável ausente',2),
('46000000-0000-4000-8000-000000000003','client_unavailable','Cliente não pôde atender',3),
('46000000-0000-4000-8000-000000000004','visit_refused','Cliente recusou a visita',4),
('46000000-0000-4000-8000-000000000005','reschedule_requested','Solicitou reagendamento',5),
('46000000-0000-4000-8000-000000000006','access_blocked','Acesso impedido',6),
('46000000-0000-4000-8000-000000000007','address_not_found','Endereço não localizado',7),
('46000000-0000-4000-8000-000000000008','business_closed','Encerrou atividades',8),
('46000000-0000-4000-8000-000000000009','other','Outro',9);

create table api.route_stop_attempt_attachments (
  id uuid primary key default gen_random_uuid(), offline_id uuid not null,
  attempt_offline_id uuid not null, seller_id uuid not null references api.user_profiles(id) on delete restrict,
  device_id uuid not null, storage_path text not null unique,
  content_type text not null check (content_type in ('image/jpeg','image/webp')),
  byte_size integer not null check (byte_size between 1 and 2097152),
  checksum text not null check (checksum ~ '^[0-9a-f]{64}$'), captured_at timestamptz not null,
  expires_at timestamptz not null, status text not null check (status in ('reserved','verified','expired')),
  reservation_key uuid not null, reservation_hash text not null check (reservation_hash ~ '^[0-9a-f]{64}$'),
  confirmation_key uuid, verified_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (seller_id,device_id,offline_id), unique (seller_id,device_id,reservation_key),
  check (expires_at between captured_at + interval '179 days' and captured_at + interval '181 days'),
  check ((status='reserved' and confirmation_key is null and verified_at is null)
    or (status in ('verified','expired') and confirmation_key is not null and verified_at is not null))
);

create table api.route_stop_attempts (
  id uuid primary key default gen_random_uuid(), offline_id uuid not null,
  route_version_id uuid not null references api.route_versions(id) on delete restrict,
  route_version_stop_id uuid not null unique,
  route_stop_execution_id uuid not null unique references api.route_stop_executions(id) on delete restrict,
  client_id uuid not null references api.clients(id) on delete restrict,
  seller_id uuid not null references api.user_profiles(id) on delete restrict,
  device_id uuid not null, reason_id uuid not null references api.route_stop_attempt_reasons(id) on delete restrict,
  observation text check (observation is null or char_length(btrim(observation)) between 1 and 500),
  attachment_id uuid not null unique references api.route_stop_attempt_attachments(id) on delete restrict,
  latitude numeric(9,6) not null check (latitude between -90 and 90),
  longitude numeric(9,6) not null check (longitude between -180 and 180),
  accuracy_m numeric(10,2) not null check (accuracy_m between 0 and 10000),
  captured_at timestamptz not null, status text not null default 'not_completed' check (status='not_completed'),
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'), recorded_at timestamptz not null default now(),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (seller_id,device_id,offline_id),
  foreign key (route_version_stop_id,route_version_id) references api.route_version_stops(id,route_version_id) on delete restrict
);
create index route_stop_attempts_seller_recorded_idx on api.route_stop_attempts (seller_id,recorded_at desc);
create index route_stop_attempt_attachments_expiry_idx on api.route_stop_attempt_attachments (expires_at) where status='verified';

create table private.field_command_receipts (
  id uuid primary key default gen_random_uuid(), actor_id uuid not null references api.user_profiles(id) on delete restrict,
  command text not null, idempotency_key uuid not null, payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  result jsonb not null, created_at timestamptz not null default now(), unique(actor_id,command,idempotency_key)
);

create trigger client_classifications_set_updated_at before update on api.client_classifications for each row execute function private.set_updated_at();
create trigger route_stop_attempt_reasons_set_updated_at before update on api.route_stop_attempt_reasons for each row execute function private.set_updated_at();
create trigger route_stop_attempt_attachments_set_updated_at before update on api.route_stop_attempt_attachments for each row execute function private.set_updated_at();
create trigger route_stop_attempts_set_updated_at before update on api.route_stop_attempts for each row execute function private.set_updated_at();

alter table api.client_classifications enable row level security; alter table api.client_classifications force row level security;
alter table api.route_stop_attempt_reasons enable row level security; alter table api.route_stop_attempt_reasons force row level security;
alter table api.route_stop_attempt_attachments enable row level security; alter table api.route_stop_attempt_attachments force row level security;
alter table api.route_stop_attempts enable row level security; alter table api.route_stop_attempts force row level security;
alter table private.field_command_receipts enable row level security; alter table private.field_command_receipts force row level security;
create policy client_classifications_route_all on api.client_classifications for all to cirne_route_executor using(true) with check(true);
create policy route_stop_attempt_reasons_route_all on api.route_stop_attempt_reasons for all to cirne_route_executor using(true) with check(true);
create policy route_stop_attempt_attachments_route_all on api.route_stop_attempt_attachments for all to cirne_route_executor using(true) with check(true);
create policy route_stop_attempts_route_all on api.route_stop_attempts for all to cirne_route_executor using(true) with check(true);
create policy field_command_receipts_route_all on private.field_command_receipts for all to cirne_route_executor using(true) with check(true);
revoke all on api.client_classifications,api.route_stop_attempt_reasons,api.route_stop_attempt_attachments,api.route_stop_attempts from public,anon,authenticated;
revoke all on private.field_command_receipts from public,anon,authenticated;
grant select on api.client_classifications,api.route_stop_attempt_reasons to cirne_route_executor;
grant select,insert,update on api.route_stop_attempt_attachments,api.route_stop_attempts to cirne_route_executor;
grant select,insert on private.field_command_receipts to cirne_route_executor;

create function private.field_command_replay(p_actor uuid,p_command text,p_key uuid,p_hash text)
returns jsonb language plpgsql volatile security definer set search_path='' as $f$
declare receipt private.field_command_receipts%rowtype;
begin
  select * into receipt from private.field_command_receipts r where r.actor_id=p_actor and r.command=p_command and r.idempotency_key=p_key for update;
  if not found then return null; end if;
  if receipt.payload_hash<>p_hash then raise exception using errcode='P0001',message='IDEMPOTENCY_KEY_REUSED'; end if;
  return receipt.result || jsonb_build_object('replayed',true);
end $f$;

create function private.guard_closed_client_new_stop()
returns trigger language plpgsql security definer set search_path='' as $f$
begin
  if exists(select 1 from api.clients c where c.id=new.client_id and c.operating_status='closed') then
    raise exception using errcode='P0001',message='CLIENT_CLOSED';
  end if;
  return new;
end $f$;
create trigger route_version_stops_guard_closed_client before insert or update of client_id on api.route_version_stops
for each row execute function private.guard_closed_client_new_stop();

create function api.list_client_classifications()
returns jsonb language sql stable security definer set search_path='' as $f$
select jsonb_build_object('schemaVersion',1,'values',coalesce(jsonb_agg(jsonb_build_object(
  'id',c.id,'code',c.code,'label',c.label,'description',c.description,'displayOrder',c.display_order) order by c.display_order),'[]'::jsonb))
from api.client_classifications c where c.published;
$f$;

create function api.get_client_field_profile(p_client_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $f$
declare ident jsonb:=private.route_identity('route.read_self'); actor uuid:=(ident->>'id')::uuid; result jsonb;
begin
  select jsonb_build_object(
    'schemaVersion',1,'clientId',c.id,'classificationId',c.classification_id,
    'classificationCode',cc.code,'classificationLabel',cc.label,
    'operatingStatus',c.operating_status,'closedReason',c.operating_closed_reason,
    'closedObservation',c.operating_closed_observation,'closedAt',c.operating_closed_at
  ) into result
  from api.clients c
  left join api.client_classifications cc on cc.id=c.classification_id
  where c.id=p_client_id and exists(
    select 1 from api.client_seller_scopes s
    where s.client_id=c.id and s.seller_id=actor and s.revoked_at is null
  );
  if result is null then raise exception using errcode='P0001',message='NOT_FOUND'; end if;
  return result;
end $f$;

create function api.search_my_route_clients(p_route_id uuid,p_query text default '')
returns jsonb language plpgsql stable security definer set search_path='' as $f$
declare ident jsonb:=private.route_identity('route.extend_self'); actor uuid:=(ident->>'id')::uuid; current_version uuid; result jsonb;
begin
  select v.id into current_version from api.routes r
  join api.route_versions v on v.route_id=r.id and v.status='published' and v.superseded_at is null
  where r.id=p_route_id and r.seller_id=actor and r.status in ('published','in_progress');
  if current_version is null then raise exception using errcode='P0001',message='NOT_FOUND'; end if;
  select jsonb_build_object('schemaVersion',1,'clients',coalesce(jsonb_agg(item order by item->>'name'),'[]'::jsonb)) into result
  from (
    select jsonb_build_object('id',c.id,'externalReference',c.external_reference,'name',c.name,
      'address',c.address,'portfolioReference',c.portfolio_reference,'alreadyOnRoute',exists(
        select 1 from api.route_version_stops rvs where rvs.route_version_id=current_version and rvs.client_id=c.id
      )) item
    from api.clients c join api.client_seller_scopes s on s.client_id=c.id and s.seller_id=actor and s.revoked_at is null
    where c.status='active' and c.archived_at is null and c.operating_status='active'
      and (coalesce(btrim(p_query),'')='' or c.name ilike '%'||btrim(p_query)||'%'
        or c.external_reference ilike '%'||btrim(p_query)||'%' or c.address ilike '%'||btrim(p_query)||'%')
    order by c.name limit 30
  ) candidates;
  return result;
end $f$;

create function api.list_management_client_field_profiles(p_client_ids uuid[])
returns jsonb language plpgsql stable security definer set search_path='' as $f$
declare ident jsonb:=private.route_identity('clients.read'); result jsonb;
begin
  if coalesce(pg_catalog.array_length(p_client_ids,1),0)>100 then
    raise exception using errcode='P0001',message='VALIDATION_FAILED';
  end if;
  select jsonb_build_object('schemaVersion',1,'profiles',coalesce(jsonb_agg(jsonb_build_object(
    'schemaVersion',1,'clientId',c.id,'classificationId',c.classification_id,
    'classificationCode',cc.code,'classificationLabel',cc.label,'operatingStatus',c.operating_status,
    'closedReason',c.operating_closed_reason,'closedObservation',c.operating_closed_observation,
    'closedAt',c.operating_closed_at) order by c.name),'[]'::jsonb)) into result
  from api.clients c left join api.client_classifications cc on cc.id=c.classification_id
  where c.id=any(coalesce(p_client_ids,'{}'::uuid[])) and (
    (ident->'roles')?'administrator' or exists(select 1 from api.client_seller_scopes s
      where s.client_id=c.id and (ident->'scopeIds')?s.seller_id::text));
  return result;
end $f$;

create function api.classify_client(p_device_id uuid,p_idempotency_key uuid,p_command jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $f$
declare ident jsonb:=private.route_identity('client.classify_self'); actor uuid:=(ident->>'id')::uuid;
  client_id uuid; classification api.client_classifications%rowtype; client api.clients%rowtype;
  hash text; replay jsonb; result jsonb; saved_at timestamptz:=clock_timestamp();
begin
  if p_device_id is null or p_idempotency_key is null or p_command->'schemaVersion'<>'1'::jsonb
     or (select count(*) from jsonb_object_keys(p_command))<>3 then raise exception using errcode='P0001',message='VALIDATION_FAILED'; end if;
  begin client_id:=(p_command->>'clientId')::uuid; exception when others then raise exception using errcode='P0001',message='VALIDATION_FAILED'; end;
  select * into classification from api.client_classifications c where c.code=p_command->>'classificationCode' and c.published;
  if not found then raise exception using errcode='P0001',message='VALIDATION_FAILED'; end if;
  if not exists(select 1 from api.client_seller_scopes s where s.client_id=client_id and s.seller_id=actor and s.revoked_at is null) then
    raise exception using errcode='P0001',message='NOT_FOUND'; end if;
  select * into client from api.clients c where c.id=client_id for update;
  hash:=encode(extensions.digest(convert_to(p_command::text,'UTF8'),'sha256'),'hex');
  replay:=private.field_command_replay(actor,'client.classify.v1',p_idempotency_key,hash); if replay is not null then return replay; end if;
  if client.classification_id=classification.id then
    result:=jsonb_build_object('schemaVersion',1,'clientId',client_id,'classificationId',classification.id,
      'classificationCode',classification.code,'classifiedAt',client.classified_at,'replayed',true);
    insert into private.field_command_receipts(actor_id,command,idempotency_key,payload_hash,result)
      values(actor,'client.classify.v1',p_idempotency_key,hash,result);
    return result;
  elsif client.classification_id is not null then
    raise exception using errcode='P0001',message='VERSION_CONFLICT';
  end if;
  update api.clients set classification_id=classification.id,classified_by=actor,classified_at=saved_at where id=client_id;
  result:=jsonb_build_object('schemaVersion',1,'clientId',client_id,'classificationId',classification.id,
    'classificationCode',classification.code,'classifiedAt',saved_at,'replayed',false);
  insert into private.field_command_receipts(actor_id,command,idempotency_key,payload_hash,result) values(actor,'client.classify.v1',p_idempotency_key,hash,result);
  insert into private.audit_events(actor_id,target_type,target_id,action,after_data,origin,request_id)
    values(actor,'client',client_id,'client.classified',result,'web',p_idempotency_key);
  return result;
end $f$;

create function api.close_client_operations(p_device_id uuid,p_idempotency_key uuid,p_command jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $f$
declare ident jsonb:=private.route_identity('client.close_self'); actor uuid:=(ident->>'id')::uuid; v_client_id uuid;
  client api.clients%rowtype; reason text; observation text; hash text; replay jsonb; result jsonb; saved_at timestamptz:=clock_timestamp();
begin
  if p_device_id is null or p_idempotency_key is null or p_command->'schemaVersion'<>'1'::jsonb then raise exception using errcode='P0001',message='VALIDATION_FAILED'; end if;
  begin v_client_id:=(p_command->>'clientId')::uuid; exception when others then raise exception using errcode='P0001',message='VALIDATION_FAILED'; end;
  reason:=btrim(p_command->>'reason'); observation:=nullif(btrim(p_command->>'observation'),'');
  if char_length(reason) not between 1 and 120 or (observation is not null and char_length(observation)>500) then raise exception using errcode='P0001',message='VALIDATION_FAILED'; end if;
  select * into client from api.clients c where c.id=v_client_id for update; if not found then raise exception using errcode='P0001',message='NOT_FOUND'; end if;
  if not exists(select 1 from api.client_seller_scopes s where s.client_id=v_client_id and s.seller_id=actor and s.revoked_at is null)
    and not (client.operating_status='closed' and client.operating_closed_by=actor) then
    raise exception using errcode='P0001',message='NOT_FOUND';
  end if;
  hash:=encode(extensions.digest(convert_to(p_command::text,'UTF8'),'sha256'),'hex'); replay:=private.field_command_replay(actor,'client.closed.v1',p_idempotency_key,hash); if replay is not null then return replay; end if;
  if client.operating_status='closed' then raise exception using errcode='P0001',message='VERSION_CONFLICT'; end if;
  update api.clients set operating_status='closed',operating_closed_reason=reason,operating_closed_observation=observation,
    operating_closed_by=actor,operating_closed_at=saved_at where id=v_client_id;
  update api.client_seller_scopes set revoked_at=saved_at,updated_at=saved_at
  where client_id=v_client_id and revoked_at is null;
  result:=jsonb_build_object('schemaVersion',1,'clientId',v_client_id,'operatingStatus','closed','closedAt',saved_at,'replayed',false);
  insert into private.field_command_receipts(actor_id,command,idempotency_key,payload_hash,result) values(actor,'client.closed.v1',p_idempotency_key,hash,result);
  insert into private.audit_events(actor_id,target_type,target_id,action,before_data,after_data,origin,request_id)
    values(actor,'client',v_client_id,'client.operating.closed',jsonb_build_object('operatingStatus','active'),result,'web',p_idempotency_key);
  return result;
end $f$;

create function api.extend_seller_route(p_device_id uuid,p_idempotency_key uuid,p_command jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $f$
declare ident jsonb:=private.route_identity('route.extend_self');actor uuid:=(ident->>'id')::uuid;
  route_id uuid;client_id uuid;expected integer;route api.routes%rowtype;old_version api.route_versions%rowtype;
  new_version_id uuid:=gen_random_uuid();new_stop_id uuid:=gen_random_uuid();new_number integer;last_order integer;
  hash text;replay jsonb;result jsonb;published_at timestamptz:=clock_timestamp();
begin
  if p_device_id is null or p_idempotency_key is null or p_command->'schemaVersion'<>'1'::jsonb
    or (select count(*) from jsonb_object_keys(p_command))<>4 then raise exception using errcode='P0001',message='VALIDATION_FAILED';end if;
  begin route_id:=(p_command->>'routeId')::uuid;client_id:=(p_command->>'clientId')::uuid;expected:=(p_command->>'expectedVersion')::integer;
  exception when others then raise exception using errcode='P0001',message='VALIDATION_FAILED';end;
  if expected<1 then raise exception using errcode='P0001',message='VALIDATION_FAILED';end if;
  select * into route from api.routes r where r.id=route_id and r.seller_id=actor for update;
  if not found then raise exception using errcode='P0001',message='NOT_FOUND';end if;
  if not exists(select 1 from api.clients c join api.client_seller_scopes s on s.client_id=c.id and s.seller_id=actor and s.revoked_at is null
    where c.id=client_id and c.status='active' and c.archived_at is null and c.operating_status='active') then raise exception using errcode='P0001',message='NOT_FOUND';end if;
  hash:=encode(extensions.digest(convert_to(p_command::text,'UTF8'),'sha256'),'hex');replay:=private.field_command_replay(actor,'route.extended.v1',p_idempotency_key,hash);if replay is not null then return replay;end if;
  if route.lock_version<>expected or route.status not in('published','in_progress') then raise exception using errcode='P0001',message='VERSION_CONFLICT';end if;
  select * into old_version from api.route_versions v where v.route_id=route.id and v.status='published' and v.superseded_at is null for update;
  if not found then raise exception using errcode='P0001',message='VERSION_CONFLICT';end if;
  if exists(select 1 from api.route_stop_executions e where e.route_version_id=old_version.id and e.status='in_visit') then raise exception using errcode='P0001',message='VERSION_CONFLICT';end if;
  if exists(select 1 from api.route_version_stops s where s.route_version_id=old_version.id and s.client_id=client_id) then raise exception using errcode='P0001',message='CLIENT_ALREADY_ON_ROUTE';end if;
  select count(*)::integer into last_order from api.route_version_stops s where s.route_version_id=old_version.id;
  if last_order>=50 then raise exception using errcode='P0001',message='ROUTE_STOP_LIMIT';end if;
  new_number:=old_version.version_number+1;
  insert into api.route_versions(id,route_id,version_number,status,created_by) values(new_version_id,route.id,new_number,'draft',actor);
  insert into api.route_version_stops(id,route_version_id,client_id,planned_order,priority,client_context_snapshot,source)
  select gen_random_uuid(),new_version_id,s.client_id,s.planned_order,s.priority,s.client_context_snapshot,s.source
    from api.route_version_stops s where s.route_version_id=old_version.id order by s.planned_order;
  insert into api.route_version_stops(id,route_version_id,client_id,planned_order,priority,client_context_snapshot,source)
  select new_stop_id,new_version_id,c.id,last_order+1,0,jsonb_build_object('id',c.id,'externalReference',c.external_reference,'name',c.name,
    'address',c.address,'latitude',case when c.location is null then null else extensions.st_y(c.location::extensions.geometry)::text end,
    'longitude',case when c.location is null then null else extensions.st_x(c.location::extensions.geometry)::text end,
    'portfolioReference',c.portfolio_reference), 'seller_ad_hoc' from api.clients c where c.id=client_id;
  insert into api.route_stop_executions(route_version_id,route_version_stop_id,execution_order,status,non_visit_reason_id,lock_version)
  select new_version_id,new_stop.id,old_execution.execution_order,old_execution.status,old_execution.non_visit_reason_id,old_execution.lock_version
  from api.route_version_stops old_stop join api.route_stop_executions old_execution on old_execution.route_version_stop_id=old_stop.id
  join api.route_version_stops new_stop on new_stop.route_version_id=new_version_id and new_stop.client_id=old_stop.client_id
  where old_stop.route_version_id=old_version.id;
  insert into api.route_stop_executions(route_version_id,route_version_stop_id,execution_order,status,lock_version)
    values(new_version_id,new_stop_id,last_order+1,'pending',1);
  insert into api.route_stop_version_lineage(previous_route_version_stop_id,successor_route_version_stop_id,
    previous_execution_id,successor_execution_id,migrated_at)
  select old_stop.id,new_stop.id,old_execution.id,new_execution.id,published_at
  from api.route_version_stops old_stop
  join api.route_stop_executions old_execution on old_execution.route_version_stop_id=old_stop.id
  join api.route_version_stops new_stop on new_stop.route_version_id=new_version_id and new_stop.client_id=old_stop.client_id
  join api.route_stop_executions new_execution on new_execution.route_version_stop_id=new_stop.id
  where old_stop.route_version_id=old_version.id;
  update api.visits visit set route_version_id=new_version_id,route_version_stop_id=lineage.successor_route_version_stop_id
  from api.route_stop_version_lineage lineage
  where visit.route_version_id=old_version.id and visit.route_version_stop_id=lineage.previous_route_version_stop_id;
  update api.route_stop_attempts attempt set route_version_id=new_version_id,
    route_version_stop_id=lineage.successor_route_version_stop_id,route_stop_execution_id=lineage.successor_execution_id
  from api.route_stop_version_lineage lineage
  where attempt.route_version_id=old_version.id and attempt.route_version_stop_id=lineage.previous_route_version_stop_id;
  update api.route_versions set status='superseded',superseded_at=published_at where id=old_version.id;
  update api.route_versions set status='published',seller_context_snapshot=old_version.seller_context_snapshot,
    published_by=actor,published_at=published_at where id=new_version_id;
  update api.routes set lock_version=lock_version+1,updated_at=published_at where id=route.id;
  result:=jsonb_build_object('schemaVersion',1,'routeId',route.id,'previousRouteVersionId',old_version.id,'routeVersionId',new_version_id,
    'versionNumber',new_number,'routeVersionStopId',new_stop_id,'source','seller_ad_hoc','replayed',false);
  insert into private.field_command_receipts(actor_id,command,idempotency_key,payload_hash,result) values(actor,'route.extended.v1',p_idempotency_key,hash,result);
  insert into private.audit_events(actor_id,target_type,target_id,action,before_data,after_data,origin,request_id)
    values(actor,'route',route.id,'route.extended.seller_ad_hoc',jsonb_build_object('routeVersionId',old_version.id,'versionNumber',old_version.version_number),result,'web',p_idempotency_key);
  return result;
end $f$;

create function api.reserve_route_stop_attempt_attachment(p_device_id uuid,p_idempotency_key uuid,p_command jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $f$
declare ident jsonb:=private.route_identity('route.attempt_self'); actor uuid:=(ident->>'id')::uuid;
  offline_id uuid; attempt_offline_id uuid; content_type text; byte_size integer; checksum text; captured timestamptz; expires timestamptz;
  hash text; existing api.route_stop_attempt_attachments%rowtype; attachment_id uuid:=gen_random_uuid(); path text;
begin
  begin offline_id:=(p_command->>'offlineId')::uuid;attempt_offline_id:=(p_command->>'attemptOfflineId')::uuid;
    content_type:=p_command->>'contentType';byte_size:=(p_command->>'byteSize')::integer;checksum:=p_command->>'checksum';
    captured:=(p_command->>'capturedAt')::timestamptz;expires:=(p_command->>'expiresAt')::timestamptz;
  exception when others then raise exception using errcode='P0001',message='VALIDATION_FAILED'; end;
  if p_device_id is null or p_idempotency_key is null or p_command->'schemaVersion'<>'1'::jsonb or content_type not in('image/jpeg','image/webp')
    or byte_size not between 1 and 2097152 or checksum!~'^[0-9a-f]{64}$' or expires not between captured+interval '179 days' and captured+interval '181 days'
  then raise exception using errcode='P0001',message='VALIDATION_FAILED'; end if;
  hash:=encode(extensions.digest(convert_to(p_command::text,'UTF8'),'sha256'),'hex');
  select * into existing from api.route_stop_attempt_attachments a where a.seller_id=actor and a.device_id=p_device_id
    and (a.offline_id=offline_id or a.reservation_key=p_idempotency_key) for update;
  if found then if existing.offline_id<>offline_id or existing.reservation_hash<>hash then raise exception using errcode='P0001',message='IDEMPOTENCY_KEY_REUSED'; end if;
    return jsonb_build_object('attachmentId',existing.id,'offlineId',existing.offline_id,'storagePath',existing.storage_path,'status',existing.status,'verifiedAt',existing.verified_at); end if;
  path:='seller/'||actor||'/route-stop-attempt/'||attempt_offline_id||'/'||attachment_id||case when content_type='image/webp' then '.webp' else '.jpg' end;
  insert into api.route_stop_attempt_attachments(id,offline_id,attempt_offline_id,seller_id,device_id,storage_path,content_type,byte_size,checksum,captured_at,expires_at,status,reservation_key,reservation_hash)
  values(attachment_id,offline_id,attempt_offline_id,actor,p_device_id,path,content_type,byte_size,checksum,captured,expires,'reserved',p_idempotency_key,hash) returning * into existing;
  return jsonb_build_object('attachmentId',existing.id,'offlineId',existing.offline_id,'storagePath',existing.storage_path,'status',existing.status,'verifiedAt',existing.verified_at);
end $f$;

create function api.confirm_route_stop_attempt_attachment(p_device_id uuid,p_idempotency_key uuid,p_offline_id uuid,p_checksum text)
returns jsonb language plpgsql volatile security definer set search_path='' as $f$
declare ident jsonb:=private.route_identity('route.attempt_self');actor uuid:=(ident->>'id')::uuid;a api.route_stop_attempt_attachments%rowtype;t timestamptz;
begin
  select * into a from api.route_stop_attempt_attachments x where x.seller_id=actor and x.device_id=p_device_id and x.offline_id=p_offline_id for update;
  if not found then raise exception using errcode='P0001',message='NOT_FOUND'; end if;
  if a.checksum<>p_checksum or not exists(
    select 1 from storage.objects o where o.bucket_id='visit-evidence' and o.name=a.storage_path
      and coalesce((o.metadata->>'size')::bigint,-1)=a.byte_size
      and lower(coalesce(o.metadata->>'mimetype',''))=a.content_type
  ) then raise exception using errcode='P0001',message='VALIDATION_FAILED'; end if;
  if a.status='verified' then if a.confirmation_key<>p_idempotency_key then raise exception using errcode='P0001',message='IDEMPOTENCY_KEY_REUSED'; end if;t:=a.verified_at;
  else t:=clock_timestamp();update api.route_stop_attempt_attachments set status='verified',confirmation_key=p_idempotency_key,verified_at=t where id=a.id; end if;
  return jsonb_build_object('schemaVersion',1,'attachmentId',a.id,'offlineId',a.offline_id,'status','verified','verifiedAt',t);
end $f$;

create function api.get_route_stop_attempt_attachment_for_confirmation(p_device_id uuid,p_offline_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $f$
declare ident jsonb:=private.route_identity('route.attempt_self');actor uuid:=(ident->>'id')::uuid;a api.route_stop_attempt_attachments%rowtype;
begin
  select * into a from api.route_stop_attempt_attachments x
  where x.seller_id=actor and x.device_id=p_device_id and x.offline_id=p_offline_id;
  if not found then raise exception using errcode='P0001',message='FORBIDDEN';end if;
  return jsonb_build_object('storagePath',a.storage_path,'contentType',a.content_type,'byteSize',a.byte_size,'checksum',a.checksum);
end $f$;

create function api.verify_route_stop_attempt_attachment(p_seller_id uuid,p_device_id uuid,p_idempotency_key uuid,p_offline_id uuid,p_checksum text)
returns jsonb language plpgsql volatile security definer set search_path='' as $f$
declare a api.route_stop_attempt_attachments%rowtype;t timestamptz;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception using errcode='P0001',message='FORBIDDEN';end if;
  select * into a from api.route_stop_attempt_attachments x where x.seller_id=p_seller_id and x.device_id=p_device_id and x.offline_id=p_offline_id for update;
  if not found then raise exception using errcode='P0001',message='FORBIDDEN';end if;
  if a.checksum<>p_checksum then raise exception using errcode='P0001',message='VALIDATION_FAILED';end if;
  if a.status='verified' then
    if a.confirmation_key<>p_idempotency_key then raise exception using errcode='P0001',message='IDEMPOTENCY_KEY_REUSED';end if;t:=a.verified_at;
  else t:=clock_timestamp();update api.route_stop_attempt_attachments set status='verified',confirmation_key=p_idempotency_key,verified_at=t where id=a.id;end if;
  return jsonb_build_object('schemaVersion',1,'attachmentId',a.id,'offlineId',a.offline_id,'status','verified','verifiedAt',t);
end $f$;

create function api.list_expired_route_stop_attempt_evidence(p_limit integer default 500)
returns table(attachment_id uuid,storage_path text) language sql stable security definer set search_path='' as $f$
  select a.id,a.storage_path from api.route_stop_attempt_attachments a
  where a.expires_at<=clock_timestamp() and a.status='verified'
  order by a.expires_at,a.id limit least(greatest(p_limit,1),5000);
$f$;

create function api.purge_expired_route_stop_attempt_evidence(p_limit integer default 500)
returns integer language plpgsql volatile security definer set search_path='' as $f$
declare changed integer;
begin
  with expired as (
    select a.id from api.route_stop_attempt_attachments a
    where a.expires_at<=clock_timestamp() and a.status='verified'
      and not exists(select 1 from storage.objects o where o.bucket_id='visit-evidence' and o.name=a.storage_path)
    order by a.expires_at,a.id limit least(greatest(p_limit,1),5000) for update skip locked
  ) update api.route_stop_attempt_attachments a set status='expired',updated_at=clock_timestamp()
    from expired where a.id=expired.id;
  get diagnostics changed=row_count; return changed;
end $f$;

create function private.can_access_route_stop_attempt_attachment(p_path text)
returns boolean language sql stable security definer set search_path='' as $f$
select exists(
  select 1 from api.route_stop_attempt_attachments a
  where a.storage_path=p_path and a.seller_id=(private.route_identity('route.attempt_self')->>'id')::uuid
    and a.expires_at>clock_timestamp()
);
$f$;

create policy route_stop_attempt_evidence_insert_self on storage.objects for insert to authenticated
with check(bucket_id='visit-evidence' and private.can_access_route_stop_attempt_attachment(name));
create policy route_stop_attempt_evidence_select_self on storage.objects for select to authenticated
using(bucket_id='visit-evidence' and private.can_access_route_stop_attempt_attachment(name));

create function api.record_route_stop_attempt(p_device_id uuid,p_idempotency_key uuid,p_command jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $f$
declare ident jsonb:=private.route_identity('route.attempt_self');actor uuid:=(ident->>'id')::uuid; offline_id uuid;stop_id uuid;attachment_offline uuid;
  reason api.route_stop_attempt_reasons%rowtype; execution api.route_stop_executions%rowtype; stop api.route_version_stops%rowtype; route api.routes%rowtype;
  attachment api.route_stop_attempt_attachments%rowtype; observation text;evidence jsonb;lat numeric;lon numeric;accuracy numeric;captured timestamptz;
  hash text;replay jsonb;attempt_id uuid:=gen_random_uuid();saved_at timestamptz:=clock_timestamp();result jsonb;
begin
  begin offline_id:=(p_command->>'offlineId')::uuid;stop_id:=(p_command->>'routeVersionStopId')::uuid;evidence:=p_command->'evidence';
    attachment_offline:=(evidence->>'attachmentOfflineId')::uuid;lat:=(evidence->>'latitude')::numeric;lon:=(evidence->>'longitude')::numeric;
    accuracy:=(evidence->>'accuracyM')::numeric;captured:=(evidence->>'capturedAt')::timestamptz;
  exception when others then raise exception using errcode='P0001',message='VALIDATION_FAILED'; end;
  observation:=nullif(btrim(p_command->>'observation'),'');select * into reason from api.route_stop_attempt_reasons r where r.code=p_command->>'reasonCode' and r.published;
  if not found or (reason.code='other' and observation is null) or char_length(coalesce(observation,''))>500 or lat not between -90 and 90 or lon not between -180 and 180 or accuracy not between 0 and 10000
    then raise exception using errcode='P0001',message='VALIDATION_FAILED'; end if;
  select * into stop from api.route_version_stops s where s.id=stop_id; if not found then raise exception using errcode='P0001',message='NOT_FOUND';end if;
  select * into route from api.routes r join api.route_versions v on v.route_id=r.id where v.id=stop.route_version_id and r.seller_id=actor for update of r;
  if not found or route.status not in('published','in_progress') then raise exception using errcode='P0001',message='NOT_FOUND';end if;
  if not exists(select 1 from api.client_seller_scopes s where s.client_id=stop.client_id and s.seller_id=actor and s.revoked_at is null)
    then raise exception using errcode='P0001',message='NOT_FOUND';end if;
  hash:=encode(extensions.digest(convert_to(p_command::text,'UTF8'),'sha256'),'hex');replay:=private.field_command_replay(actor,'route.stop.not_completed.v1',p_idempotency_key,hash);if replay is not null then return replay;end if;
  select * into execution from api.route_stop_executions e where e.route_version_stop_id=stop_id for update;
  if not found or execution.status<>'pending' then raise exception using errcode='P0001',message='VERSION_CONFLICT';end if;
  if exists(select 1 from api.visits v where v.route_version_stop_id=stop_id) then raise exception using errcode='P0001',message='VERSION_CONFLICT';end if;
  select * into attachment from api.route_stop_attempt_attachments a where a.seller_id=actor and a.device_id=p_device_id and a.offline_id=attachment_offline and a.attempt_offline_id=offline_id and a.status='verified' for update;
  if not found then raise exception using errcode='P0001',message='EVIDENCE_REQUIRED';end if;
  insert into api.route_stop_attempts(id,offline_id,route_version_id,route_version_stop_id,route_stop_execution_id,client_id,seller_id,device_id,reason_id,observation,attachment_id,latitude,longitude,accuracy_m,captured_at,payload_hash,recorded_at)
    values(attempt_id,offline_id,stop.route_version_id,stop.id,execution.id,stop.client_id,actor,p_device_id,reason.id,observation,attachment.id,lat,lon,accuracy,captured,hash,saved_at);
  update api.route_stop_executions set status='not_visited',non_visit_reason_id=reason.id,lock_version=lock_version+1 where id=execution.id;
  result:=jsonb_build_object('schemaVersion',1,'attemptId',attempt_id,'offlineId',offline_id,'routeVersionStopId',stop.id,'status','not_completed','reasonCode',reason.code,'recordedAt',saved_at,'replayed',false);
  insert into private.field_command_receipts(actor_id,command,idempotency_key,payload_hash,result) values(actor,'route.stop.not_completed.v1',p_idempotency_key,hash,result);
  insert into private.audit_events(actor_id,target_type,target_id,action,after_data,origin,request_id) values(actor,'route_stop_attempt',attempt_id,'route.stop.not_completed',result,'web',p_idempotency_key);
  return result;
end $f$;

grant select on api.route_stop_attempt_reasons to cirne_management_executor;
grant create on schema api to cirne_management_executor;
do $management_ownership$
begin
  execute pg_catalog.format('grant cirne_management_executor to %I with set true granted by current_user',current_user);
end
$management_ownership$;
set local role cirne_management_executor;
create or replace view api.management_day_v as
select route_row.id as route_id,route_row.service_date,route_row.seller_id,
  version_row.seller_context_snapshot->>'displayName' as seller_display_name,
  version_row.id as route_version_id,version_row.version_number,stop_row.id as route_version_stop_id,
  stop_row.client_id,coalesce(stop_row.client_context_snapshot->>'name',client.name) as client_name,
  execution_row.status,execution_row.non_visit_reason_id,
  greatest(route_row.updated_at,execution_row.updated_at) as last_known_update_at,
  stop_row.planned_order,execution_row.execution_order,stop_row.priority,
  coalesce(parameter_reason.label,attempt_reason.label,'Motivo registrado') as non_visit_reason_label
from api.routes route_row
join api.route_versions version_row on version_row.route_id=route_row.id and version_row.status='published' and version_row.superseded_at is null
join api.route_version_stops stop_row on stop_row.route_version_id=version_row.id
join api.route_stop_executions execution_row on execution_row.route_version_stop_id=stop_row.id
join api.clients client on client.id=stop_row.client_id
left join api.parameter_values parameter_reason on parameter_reason.id=execution_row.non_visit_reason_id
left join api.route_stop_attempt_reasons attempt_reason on attempt_reason.id=execution_row.non_visit_reason_id
where route_row.status in('published','in_progress','closed');

create function api.list_management_day_route_stop_attempts(p_service_date date)
returns jsonb language plpgsql stable security definer set search_path='' as $f$
declare ident jsonb:=private.management_identity();result jsonb;
begin
  select jsonb_build_object('schemaVersion',1,'attempts',coalesce(jsonb_agg(jsonb_build_object(
    'routeVersionStopId',item.route_version_stop_id,'attempt',jsonb_build_object('attemptId',item.id,
    'observation',item.observation,'recordedAt',item.recorded_at,'capturedAt',item.captured_at,
    'latitude',item.latitude,'longitude',item.longitude,'accuracyM',item.accuracy_m,'attachmentId',item.attachment_id)
  ) order by item.recorded_at),'[]'::jsonb)) into result from (
    select distinct on(a.route_version_stop_id) a.* from api.route_stop_attempts a
    join api.routes r on r.id=(select rv.route_id from api.route_versions rv where rv.id=a.route_version_id)
    where r.service_date=p_service_date and exists(select 1 from jsonb_array_elements_text(ident->'scopeIds') s(id) where s.id::uuid=a.seller_id)
    order by a.route_version_stop_id,a.recorded_at desc,a.id desc
  ) item;return result;
end $f$;

create function api.get_management_route_stop_attempt_attachment(p_attachment_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $f$
declare ident jsonb:=private.management_identity();result jsonb;
begin
  select jsonb_build_object('storagePath',att.storage_path,'contentType',att.content_type) into result
  from api.route_stop_attempt_attachments att join api.route_stop_attempts a on a.attachment_id=att.id
  where att.id=p_attachment_id and att.status='verified' and exists(select 1 from jsonb_array_elements_text(ident->'scopeIds') s(id) where s.id::uuid=a.seller_id);
  if result is null then raise exception using errcode='P0001',message='NOT_FOUND';end if;return result;
end $f$;
-- Apply ACLs while the defining role is still active. PostgreSQL grants PUBLIC
-- EXECUTE to new functions by default, and the bootstrap role deliberately loses
-- membership in cirne_management_executor immediately below.
revoke all on function api.list_management_day_route_stop_attempts(date),api.get_management_route_stop_attempt_attachment(uuid) from public,anon;
grant execute on function api.list_management_day_route_stop_attempts(date),api.get_management_route_stop_attempt_attachment(uuid) to authenticated;
reset role;
revoke create on schema api from cirne_management_executor;
do $management_ownership$
begin
  execute pg_catalog.format('revoke cirne_management_executor from %I granted by current_user',current_user);
end
$management_ownership$;

grant create on schema api,private to cirne_route_executor;
alter table api.client_classifications owner to cirne_route_executor;
alter table api.route_stop_attempt_reasons owner to cirne_route_executor;
alter table api.route_stop_attempt_attachments owner to cirne_route_executor;
alter table api.route_stop_attempts owner to cirne_route_executor;
alter table api.route_stop_version_lineage owner to cirne_route_executor;
alter table private.field_command_receipts owner to cirne_route_executor;
alter function private.field_command_replay(uuid,text,uuid,text) owner to cirne_route_executor;
alter function private.guard_closed_client_new_stop() owner to cirne_route_executor;
alter function api.list_client_classifications() owner to cirne_route_executor;
alter function api.get_client_field_profile(uuid) owner to cirne_route_executor;
alter function api.list_management_client_field_profiles(uuid[]) owner to cirne_route_executor;
alter function api.search_my_route_clients(uuid,text) owner to cirne_route_executor;
alter function api.classify_client(uuid,uuid,jsonb) owner to cirne_route_executor;
alter function api.close_client_operations(uuid,uuid,jsonb) owner to cirne_route_executor;
alter function api.extend_seller_route(uuid,uuid,jsonb) owner to cirne_route_executor;
alter function api.reserve_route_stop_attempt_attachment(uuid,uuid,jsonb) owner to cirne_route_executor;
alter function api.confirm_route_stop_attempt_attachment(uuid,uuid,uuid,text) owner to cirne_route_executor;
alter function api.get_route_stop_attempt_attachment_for_confirmation(uuid,uuid) owner to cirne_route_executor;
alter function api.verify_route_stop_attempt_attachment(uuid,uuid,uuid,uuid,text) owner to cirne_route_executor;
alter function api.list_expired_route_stop_attempt_evidence(integer) owner to cirne_route_executor;
alter function api.purge_expired_route_stop_attempt_evidence(integer) owner to cirne_route_executor;
alter function api.record_route_stop_attempt(uuid,uuid,jsonb) owner to cirne_route_executor;
alter function private.can_access_route_stop_attempt_attachment(text) owner to cirne_route_executor;
revoke create on schema api,private from cirne_route_executor;
revoke all on function api.list_client_classifications(),api.get_client_field_profile(uuid),api.list_management_client_field_profiles(uuid[]),api.search_my_route_clients(uuid,text),api.classify_client(uuid,uuid,jsonb),api.close_client_operations(uuid,uuid,jsonb),api.extend_seller_route(uuid,uuid,jsonb),
 api.reserve_route_stop_attempt_attachment(uuid,uuid,jsonb),api.confirm_route_stop_attempt_attachment(uuid,uuid,uuid,text),api.record_route_stop_attempt(uuid,uuid,jsonb) from public,anon;
grant execute on function api.list_client_classifications(),api.get_client_field_profile(uuid),api.list_management_client_field_profiles(uuid[]),api.search_my_route_clients(uuid,text),api.classify_client(uuid,uuid,jsonb),api.close_client_operations(uuid,uuid,jsonb),api.extend_seller_route(uuid,uuid,jsonb),
 api.reserve_route_stop_attempt_attachment(uuid,uuid,jsonb),api.get_route_stop_attempt_attachment_for_confirmation(uuid,uuid),api.record_route_stop_attempt(uuid,uuid,jsonb) to authenticated;
revoke all on function api.confirm_route_stop_attempt_attachment(uuid,uuid,uuid,text),api.verify_route_stop_attempt_attachment(uuid,uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function api.verify_route_stop_attempt_attachment(uuid,uuid,uuid,uuid,text) to service_role;
revoke all on function api.list_expired_route_stop_attempt_evidence(integer),api.purge_expired_route_stop_attempt_evidence(integer) from public,anon,authenticated;
grant execute on function api.list_expired_route_stop_attempt_evidence(integer),api.purge_expired_route_stop_attempt_evidence(integer) to service_role;

comment on column api.clients.operating_status is 'Operational availability, independent from administrative status/archiving.';
comment on table api.route_stop_attempts is 'Terminal non-visit outcome; deliberately separate from api.visits.';

do $ownership$
begin
  execute pg_catalog.format('revoke usage on schema private from %I',current_user);
  execute pg_catalog.format('revoke cirne_route_executor from %I granted by current_user',current_user);
end
$ownership$;
commit;
