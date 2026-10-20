-- Story 3.12: audited manual client creation and correction.
-- Rollback is forward-only: disable the API grants first, keep client/audit data,
-- then remove wrappers/helpers in a new migration after all deployed callers stop.
begin;

select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cirne:database:migrate'));
set local lock_timeout = '5s';

insert into api.role_permissions (role_id, permission_code)
values
  ('00000000-0000-4000-8000-000000000002', 'clients.manage'),
  ('00000000-0000-4000-8000-000000000003', 'clients.manage')
on conflict (role_id, permission_code) do nothing;

do $membership$
begin
  execute pg_catalog.format('grant cirne_route_executor to %I with set true granted by current_user', current_user);
end
$membership$;
set local role cirne_route_executor;
alter table api.clients
  add column lock_version integer not null default 1 check (lock_version > 0);
reset role;
alter table api.client_seller_scopes
  add column managed_by_manual_maintenance boolean not null default false;

create table private.client_management_commands (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references api.user_profiles(id) on delete restrict,
  operation text not null check (operation in ('client.manual.created.v1','client.manual.updated.v1')),
  idempotency_key uuid not null,
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  client_id uuid not null references api.clients(id) on delete restrict,
  canonical_result jsonb not null,
  created_at timestamptz not null default now(),
  constraint client_management_commands_key unique (actor_id, operation, idempotency_key)
);

create index client_management_commands_client_idx
  on private.client_management_commands (client_id, created_at desc);
create index client_seller_scopes_manual_idx
  on api.client_seller_scopes (client_id, created_at desc)
  where managed_by_manual_maintenance and revoked_at is null;

alter table private.client_management_commands enable row level security;
alter table private.client_management_commands force row level security;
revoke all on private.client_management_commands from public, anon, authenticated;

grant usage, create on schema api, private to cirne_route_executor;
grant select, insert on private.client_management_commands to cirne_route_executor;
grant select on api.client_seller_scopes, api.user_seller_scopes,
  api.user_profiles, api.roles, api.user_role_assignments to cirne_route_executor;
alter table private.client_management_commands owner to cirne_route_executor;

set local role cirne_route_executor;

create policy client_management_commands_executor_all
  on private.client_management_commands for all to cirne_route_executor
  using (true) with check (true);

create function private.normalize_client_external_reference(p_value text)
returns text language sql immutable security invoker set search_path = ''
as $function$
  select case
    when normalized.compact ~ '^[0-9.\-/ ]+$'
      then pg_catalog.regexp_replace(normalized.compact, '[^0-9]', '', 'g')
    else pg_catalog.upper(normalized.compact)
  end
  from (select pg_catalog.regexp_replace(pg_catalog.btrim(p_value), '\s+', ' ', 'g') as compact) normalized;
$function$;

create function private.normalize_client_import_command(p_command jsonb)
returns jsonb language plpgsql stable security definer set search_path = ''
as $function$
declare
  normalized_rows jsonb := '[]'::jsonb;
  item jsonb;
begin
  if p_command is null or jsonb_typeof(p_command) is distinct from 'object'
     or jsonb_typeof(p_command -> 'rows') is distinct from 'array' then
    return p_command;
  end if;
  for item in select value from jsonb_array_elements(p_command -> 'rows') loop
    if jsonb_typeof(item) = 'object' and jsonb_typeof(item -> 'externalReference') = 'string' then
      item := jsonb_set(item, '{externalReference}',
        to_jsonb(private.normalize_client_external_reference(item ->> 'externalReference')));
    end if;
    normalized_rows := normalized_rows || jsonb_build_array(item);
  end loop;
  return jsonb_set(p_command, '{rows}', normalized_rows);
end
$function$;

create function private.normalize_client_external_reference_row()
returns trigger language plpgsql security invoker set search_path = ''
as $function$
begin
  if new.external_reference is not null then
    new.external_reference := private.normalize_client_external_reference(new.external_reference);
  end if;
  return new;
end
$function$;

create function private.bump_client_lock_version()
returns trigger language plpgsql security invoker set search_path = ''
as $function$
begin
  new.lock_version := old.lock_version + 1;
  return new;
end
$function$;

create function private.prevent_client_delete()
returns trigger language plpgsql security invoker set search_path = ''
as $function$
begin
  raise exception using errcode = 'P0001', message = 'CLIENT_DELETE_FORBIDDEN';
end
$function$;

create function private.client_management_identity()
returns jsonb language sql stable security definer set search_path = ''
as $function$ select private.route_identity('clients.manage'); $function$;

create function private.client_management_visible(p_identity jsonb, p_client_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $function$
  select p_identity -> 'roles' ? 'administrator' or exists (
    select 1 from api.client_seller_scopes scope
    where scope.client_id = p_client_id and scope.revoked_at is null
      and p_identity -> 'scopeIds' ? scope.seller_id::text
  );
$function$;

create function private.client_management_document(p_client_id uuid, p_identity jsonb)
returns jsonb language sql stable security definer set search_path = ''
as $function$
  select jsonb_build_object(
    'schemaVersion', 1,
    'id', client.id,
    'externalReference', client.external_reference,
    'name', client.name,
    'address', client.address,
    'latitude', extensions.st_y(client.location::extensions.geometry),
    'longitude', extensions.st_x(client.location::extensions.geometry),
    'portfolioReference', client.portfolio_reference,
    'sellerId', selected_scope.seller_id,
    'sellerEmail', private.user_email(selected_scope.seller_id),
    'status', case when client.status = 'active' then 'active' else 'archived' end,
    'version', client.lock_version
  )
  from api.clients client
  left join lateral (
    select scope.seller_id
    from api.client_seller_scopes scope
    where scope.client_id = client.id and scope.revoked_at is null
      and (p_identity -> 'roles' ? 'administrator'
        or p_identity -> 'scopeIds' ? scope.seller_id::text)
    order by scope.managed_by_manual_maintenance desc, scope.created_at desc, scope.id
    limit 1
  ) selected_scope on true
  where client.id = p_client_id
    and (p_identity -> 'roles' ? 'administrator' or selected_scope.seller_id is not null);
$function$;

create function private.client_management_seller(p_identity jsonb, p_email text)
returns uuid language plpgsql stable security definer set search_path = ''
as $function$
declare seller_id uuid;
begin
  seller_id := private.valid_import_seller(p_email);
  if seller_id is null or not private.import_seller_authorized(p_identity, seller_id) then
    raise exception using errcode = 'P0001', message = 'SELLER_NOT_FOUND';
  end if;
  return seller_id;
end
$function$;

create function private.client_create_command_valid(p_command jsonb)
returns boolean language sql immutable security invoker set search_path = ''
as $function$
  select p_command is not null
    and jsonb_typeof(p_command) = 'object'
    and (p_command - array['schemaVersion','externalReference','name','address','latitude','longitude',
      'portfolioReference','sellerEmail','status']) = '{}'::jsonb
    and p_command -> 'schemaVersion' = '1'::jsonb
    and jsonb_typeof(p_command -> 'externalReference') = 'string'
    and char_length(private.normalize_client_external_reference(p_command ->> 'externalReference')) between 1 and 120
    and jsonb_typeof(p_command -> 'name') = 'string'
    and char_length(btrim(p_command ->> 'name')) between 1 and 160
    and jsonb_typeof(p_command -> 'address') = 'string'
    and char_length(btrim(p_command ->> 'address')) between 1 and 300
    and jsonb_typeof(p_command -> 'sellerEmail') = 'string'
    and char_length(btrim(p_command ->> 'sellerEmail')) between 3 and 254
    and jsonb_typeof(p_command -> 'status') = 'string'
    and p_command ->> 'status' in ('active','archived')
    and jsonb_typeof(p_command -> 'latitude') in ('number','null')
    and jsonb_typeof(p_command -> 'longitude') in ('number','null')
    and ((p_command ->> 'latitude') is null) = ((p_command ->> 'longitude') is null)
    and ((p_command ->> 'latitude') is null or (p_command ->> 'latitude')::numeric between -90 and 90)
    and ((p_command ->> 'longitude') is null or (p_command ->> 'longitude')::numeric between -180 and 180)
    and jsonb_typeof(p_command -> 'portfolioReference') in ('string','null')
    and ((p_command ->> 'portfolioReference') is null
      or char_length(btrim(p_command ->> 'portfolioReference')) <= 120);
$function$;

create function private.client_update_command_valid(p_command jsonb)
returns boolean language sql immutable security invoker set search_path = ''
as $function$
  select private.client_create_command_valid(
    (p_command - array['expectedVersion','reason']) || jsonb_build_object(
      'externalReference', 'VALIDATION-PLACEHOLDER'))
    and (p_command - array['schemaVersion','expectedVersion','reason','name','address','latitude','longitude',
      'portfolioReference','sellerEmail','status']) = '{}'::jsonb
    and jsonb_typeof(p_command -> 'expectedVersion') = 'number'
    and coalesce(p_command ->> 'expectedVersion','') ~ '^[1-9][0-9]*$'
    and jsonb_typeof(p_command -> 'reason') = 'string'
    and char_length(btrim(p_command ->> 'reason')) between 1 and 500;
$function$;

create function private.get_managed_client(p_client_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $function$
declare identity_document jsonb := private.client_management_identity();
declare result_document jsonb;
begin
  result_document := private.client_management_document(p_client_id, identity_document);
  if result_document is null then
    raise exception using errcode = 'P0001', message = 'NOT_FOUND';
  end if;
  return result_document;
end
$function$;

create function private.list_client_management_sellers()
returns jsonb language plpgsql stable security definer set search_path = ''
as $function$
declare identity_document jsonb := private.client_management_identity();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', seller.id, 'displayName', seller.display_name, 'email', private.user_email(seller.id)
    ) order by seller.display_name, seller.id)
    from api.user_profiles seller
    where seller.status = 'active' and seller.blocked_at is null
      and (identity_document -> 'roles' ? 'administrator'
        or identity_document -> 'scopeIds' ? seller.id::text)
      and exists (
        select 1 from api.user_role_assignments assignment
        join api.roles role_row on role_row.id = assignment.role_id and role_row.code = 'seller'
        where assignment.user_id = seller.id and assignment.revoked_at is null
      )
  ), '[]'::jsonb);
end
$function$;

create function private.create_managed_client(
  p_command jsonb, p_idempotency_key uuid, p_origin text default 'web'
) returns jsonb language plpgsql volatile security definer set search_path = ''
as $function$
declare
  identity_document jsonb := private.client_management_identity();
  v_actor_id uuid := (identity_document ->> 'id')::uuid;
  payload_hash text;
  existing_command private.client_management_commands%rowtype;
  existing_client_id uuid;
  client_id uuid;
  seller_id uuid;
  result_document jsonb;
  reference_value text;
  latitude_value double precision;
  longitude_value double precision;
begin
  if p_idempotency_key is null or p_origin not in ('web','cli')
     or not coalesce(private.client_create_command_valid(p_command), false) then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  reference_value := private.normalize_client_external_reference(p_command ->> 'externalReference');
  payload_hash := encode(extensions.digest(convert_to(p_command::text,'UTF8'),'sha256'),'hex');
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    v_actor_id::text || ':client.manual.created.v1:' || p_idempotency_key::text, 0));
  select * into existing_command from private.client_management_commands
  where client_management_commands.actor_id = v_actor_id
    and operation = 'client.manual.created.v1' and idempotency_key = p_idempotency_key;
  if found then
    if existing_command.payload_hash <> payload_hash then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    if not private.client_management_visible(identity_document, existing_command.client_id) then
      raise exception using errcode = 'P0001', message = 'NOT_FOUND';
    end if;
    return jsonb_set(existing_command.canonical_result, '{replayed}', 'true'::jsonb);
  end if;

  seller_id := private.client_management_seller(identity_document, p_command ->> 'sellerEmail');
  select id into existing_client_id from api.clients where external_reference = reference_value;
  if existing_client_id is not null then
    result_document := private.client_management_document(existing_client_id, identity_document);
    if result_document is null then
      raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT';
    end if;
    raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT',
      detail = jsonb_build_object('current', result_document)::text;
  end if;
  latitude_value := nullif(p_command ->> 'latitude','')::double precision;
  longitude_value := nullif(p_command ->> 'longitude','')::double precision;
  begin
    insert into api.clients (
      external_reference, name, address, location, portfolio_reference, status, archived_at
    ) values (
      reference_value, btrim(p_command ->> 'name'), btrim(p_command ->> 'address'),
      case when latitude_value is null then null else
        extensions.st_setsrid(extensions.st_makepoint(longitude_value, latitude_value),4326)::extensions.geography end,
      nullif(btrim(p_command ->> 'portfolioReference'),''),
      case when p_command ->> 'status' = 'archived' then 'inactive' else 'active' end,
      case when p_command ->> 'status' = 'archived' then now() else null end
    ) returning id into client_id;
  exception when unique_violation then
    select id into existing_client_id from api.clients where external_reference = reference_value;
    result_document := private.client_management_document(existing_client_id, identity_document);
    if result_document is null then
      raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT';
    end if;
    raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT',
      detail = jsonb_build_object('current', result_document)::text;
  end;

  perform private.apply_manual_client_scope(client_id, seller_id, v_actor_id);
  result_document := private.client_management_document(client_id, identity_document);
  insert into private.audit_events (
    actor_id, target_type, target_id, action, after_data, origin, request_id
  ) values (
    v_actor_id, 'client', client_id, 'client.manual.created.v1', result_document, p_origin, p_idempotency_key
  );
  result_document := jsonb_build_object('schemaVersion',1,'replayed',false,'client',result_document);
  insert into private.client_management_commands (
    actor_id, operation, idempotency_key, payload_hash, client_id, canonical_result
  ) values (
    v_actor_id, 'client.manual.created.v1', p_idempotency_key, payload_hash, client_id, result_document
  );
  return result_document;
end
$function$;

create function private.update_managed_client(
  p_client_id uuid, p_command jsonb, p_idempotency_key uuid, p_origin text default 'web'
) returns jsonb language plpgsql volatile security definer set search_path = ''
as $function$
declare
  identity_document jsonb := private.client_management_identity();
  v_actor_id uuid := (identity_document ->> 'id')::uuid;
  payload_hash text;
  existing_command private.client_management_commands%rowtype;
  client_row api.clients%rowtype;
  seller_id uuid;
  before_document jsonb;
  after_document jsonb;
  result_document jsonb;
  latitude_value double precision;
  longitude_value double precision;
begin
  if p_client_id is null or p_idempotency_key is null or p_origin not in ('web','cli')
     or not coalesce(private.client_update_command_valid(p_command), false) then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  payload_hash := encode(extensions.digest(convert_to(
    jsonb_build_object('clientId',p_client_id,'command',p_command)::text,'UTF8'),'sha256'),'hex');
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    v_actor_id::text || ':client.manual.updated.v1:' || p_idempotency_key::text, 0));
  select * into existing_command from private.client_management_commands
  where client_management_commands.actor_id = v_actor_id
    and operation = 'client.manual.updated.v1' and idempotency_key = p_idempotency_key;
  if found then
    if existing_command.payload_hash <> payload_hash then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    if not private.client_management_visible(identity_document, existing_command.client_id) then
      raise exception using errcode = 'P0001', message = 'NOT_FOUND';
    end if;
    return jsonb_set(existing_command.canonical_result, '{replayed}', 'true'::jsonb);
  end if;

  select * into client_row from api.clients where id = p_client_id for update;
  if not found or not private.client_management_visible(identity_document, p_client_id) then
    raise exception using errcode = 'P0001', message = 'NOT_FOUND';
  end if;
  before_document := private.client_management_document(p_client_id, identity_document);
  if client_row.lock_version <> (p_command ->> 'expectedVersion')::integer then
    raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT',
      detail = jsonb_build_object('current', before_document)::text;
  end if;
  seller_id := private.client_management_seller(identity_document, p_command ->> 'sellerEmail');
  latitude_value := nullif(p_command ->> 'latitude','')::double precision;
  longitude_value := nullif(p_command ->> 'longitude','')::double precision;
  update api.clients set
    name = btrim(p_command ->> 'name'),
    address = btrim(p_command ->> 'address'),
    location = case when latitude_value is null then null else
      extensions.st_setsrid(extensions.st_makepoint(longitude_value, latitude_value),4326)::extensions.geography end,
    portfolio_reference = nullif(btrim(p_command ->> 'portfolioReference'),''),
    status = case when p_command ->> 'status' = 'archived' then 'inactive' else 'active' end,
    archived_at = case when p_command ->> 'status' = 'archived' then coalesce(archived_at, now()) else null end
  where id = p_client_id and lock_version = client_row.lock_version;
  if not found then
    raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT',
      detail = jsonb_build_object('current', private.client_management_document(p_client_id, identity_document))::text;
  end if;
  perform private.apply_manual_client_scope(p_client_id, seller_id, v_actor_id);
  after_document := private.client_management_document(p_client_id, identity_document);
  insert into private.audit_events (
    actor_id, target_type, target_id, action, before_data, after_data, reason, origin, request_id
  ) values (
    v_actor_id, 'client', p_client_id, 'client.manual.updated.v1', before_document, after_document,
    btrim(p_command ->> 'reason'), p_origin, p_idempotency_key
  );
  result_document := jsonb_build_object('schemaVersion',1,'replayed',false,'client',after_document);
  insert into private.client_management_commands (
    actor_id, operation, idempotency_key, payload_hash, client_id, canonical_result
  ) values (
    v_actor_id, 'client.manual.updated.v1', p_idempotency_key, payload_hash, p_client_id, result_document
  );
  return result_document;
end
$function$;

create or replace function private.list_import_clients(p_limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path = ''
as $function$
declare identity_document jsonb := private.route_identity('clients.read');
begin
  return coalesce((select jsonb_agg(jsonb_build_object(
    'schemaVersion', 1,
    'id', selected.id, 'externalReference', selected.external_reference, 'name', selected.name,
    'address', selected.address, 'latitude', extensions.st_y(selected.location::extensions.geometry),
    'longitude', extensions.st_x(selected.location::extensions.geometry),
    'portfolioReference', selected.portfolio_reference, 'sellerId', selected.seller_id,
    'sellerEmail', private.user_email(selected.seller_id),
    'status', case when selected.status = 'active' then 'active' else 'archived' end,
    'version', selected.lock_version
  ) order by selected.name, selected.id)
  from (
    select client.*, active_scope.seller_id
    from api.clients client
    left join lateral (
      select scope.seller_id from api.client_seller_scopes scope
      where scope.client_id = client.id and scope.revoked_at is null
        and (identity_document -> 'roles' ? 'administrator'
          or identity_document -> 'scopeIds' ? scope.seller_id::text)
      order by scope.managed_by_manual_maintenance desc, scope.created_at desc, scope.id limit 1
    ) active_scope on true
    where identity_document -> 'roles' ? 'administrator'
      or (active_scope.seller_id is not null and identity_document -> 'scopeIds' ? active_scope.seller_id::text)
    order by client.name, client.id limit least(greatest(p_limit,1),100)
  ) selected), '[]'::jsonb);
end
$function$;

reset role;

do $normalized_collision$
begin
  if exists (
    select private.normalize_client_external_reference(external_reference)
    from api.clients where external_reference is not null
    group by private.normalize_client_external_reference(external_reference) having count(*) > 1
  ) then
    raise exception 'Client external-reference normalization would create duplicates';
  end if;
end
$normalized_collision$;

update api.clients set external_reference = private.normalize_client_external_reference(external_reference)
where external_reference is not null
  and external_reference <> private.normalize_client_external_reference(external_reference);

create trigger clients_normalize_external_reference
before insert or update of external_reference on api.clients
for each row execute function private.normalize_client_external_reference_row();
create trigger clients_bump_lock_version
before update on api.clients
for each row execute function private.bump_client_lock_version();
create trigger clients_prevent_delete
before delete on api.clients
for each row execute function private.prevent_client_delete();

create or replace function private.apply_import_client_scope(
  p_client_id uuid, p_seller_id uuid, p_actor_id uuid, p_batch_id uuid
) returns void language plpgsql volatile security definer set search_path = ''
as $function$
begin
  update api.client_seller_scopes set revoked_at = now(), updated_at = now()
  where client_id = p_client_id and seller_id <> p_seller_id and revoked_at is null
    and (managed_by_import_batch_id is not null or managed_by_manual_maintenance);
  insert into api.client_seller_scopes
    (client_id, seller_id, assigned_by, managed_by_import_batch_id, managed_by_manual_maintenance)
  values (p_client_id, p_seller_id, p_actor_id, p_batch_id, false)
  on conflict (client_id, seller_id) where revoked_at is null do update set
    assigned_by = excluded.assigned_by,
    managed_by_import_batch_id = excluded.managed_by_import_batch_id,
    managed_by_manual_maintenance = false,
    updated_at = now();
end
$function$;

create function private.apply_manual_client_scope(
  p_client_id uuid, p_seller_id uuid, p_actor_id uuid
) returns void language plpgsql volatile security definer set search_path = ''
as $function$
begin
  update api.client_seller_scopes set revoked_at = now(), updated_at = now()
  where client_id = p_client_id and seller_id <> p_seller_id and revoked_at is null
    and managed_by_manual_maintenance;
  insert into api.client_seller_scopes
    (client_id, seller_id, assigned_by, managed_by_manual_maintenance)
  values (p_client_id, p_seller_id, p_actor_id, true)
  on conflict (client_id, seller_id) where revoked_at is null do nothing;
end
$function$;

alter function private.apply_import_client_scope(uuid,uuid,uuid,uuid) owner to postgres;
alter function private.apply_manual_client_scope(uuid,uuid,uuid) owner to postgres;
revoke all on function private.apply_import_client_scope(uuid,uuid,uuid,uuid),
  private.apply_manual_client_scope(uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function private.apply_import_client_scope(uuid,uuid,uuid,uuid),
  private.apply_manual_client_scope(uuid,uuid,uuid) to cirne_route_executor;

create or replace function api.execute_client_import(p_command jsonb, p_origin text default 'web')
returns jsonb language sql volatile security definer set search_path = ''
as $function$
  select private.execute_client_import(private.normalize_client_import_command(p_command), p_origin);
$function$;

create function api.create_client(p_command jsonb, p_idempotency_key uuid, p_origin text default 'web')
returns jsonb language sql volatile security definer set search_path = ''
as $function$ select private.create_managed_client(p_command,p_idempotency_key,p_origin); $function$;
create function api.get_client(p_client_id uuid)
returns jsonb language sql stable security definer set search_path = ''
as $function$ select private.get_managed_client(p_client_id); $function$;
create function api.update_client(
  p_client_id uuid, p_command jsonb, p_idempotency_key uuid, p_origin text default 'web'
) returns jsonb language sql volatile security definer set search_path = ''
as $function$ select private.update_managed_client(p_client_id,p_command,p_idempotency_key,p_origin); $function$;
create function api.list_client_management_sellers()
returns jsonb language sql stable security definer set search_path = ''
as $function$ select private.list_client_management_sellers(); $function$;

alter function private.normalize_client_external_reference(text) owner to cirne_route_executor;
alter function private.normalize_client_import_command(jsonb) owner to cirne_route_executor;
alter function private.normalize_client_external_reference_row() owner to cirne_route_executor;
alter function private.bump_client_lock_version() owner to cirne_route_executor;
alter function private.prevent_client_delete() owner to cirne_route_executor;
alter function private.client_management_identity() owner to cirne_route_executor;
alter function private.client_management_visible(jsonb,uuid) owner to cirne_route_executor;
alter function private.client_management_document(uuid,jsonb) owner to cirne_route_executor;
alter function private.client_management_seller(jsonb,text) owner to cirne_route_executor;
alter function private.client_create_command_valid(jsonb) owner to cirne_route_executor;
alter function private.client_update_command_valid(jsonb) owner to cirne_route_executor;
alter function private.get_managed_client(uuid) owner to cirne_route_executor;
alter function private.list_client_management_sellers() owner to cirne_route_executor;
alter function private.create_managed_client(jsonb,uuid,text) owner to cirne_route_executor;
alter function private.update_managed_client(uuid,jsonb,uuid,text) owner to cirne_route_executor;
alter function api.create_client(jsonb,uuid,text) owner to cirne_route_executor;
alter function api.get_client(uuid) owner to cirne_route_executor;
alter function api.update_client(uuid,jsonb,uuid,text) owner to cirne_route_executor;
alter function api.list_client_management_sellers() owner to cirne_route_executor;

revoke all on function api.create_client(jsonb,uuid,text), api.get_client(uuid),
  api.update_client(uuid,jsonb,uuid,text), api.list_client_management_sellers()
  from public, anon;
grant execute on function api.create_client(jsonb,uuid,text), api.get_client(uuid),
  api.update_client(uuid,jsonb,uuid,text), api.list_client_management_sellers()
  to authenticated, service_role;
revoke all on function private.normalize_client_import_command(jsonb),
  private.normalize_client_external_reference(text),
  private.client_management_identity(), private.client_management_visible(jsonb,uuid),
  private.client_management_document(uuid,jsonb), private.client_management_seller(jsonb,text),
  private.client_create_command_valid(jsonb), private.client_update_command_valid(jsonb),
  private.get_managed_client(uuid), private.list_client_management_sellers(),
  private.create_managed_client(jsonb,uuid,text), private.update_managed_client(uuid,jsonb,uuid,text)
  from public, anon, authenticated;

set local role cirne_route_executor;
comment on column api.clients.lock_version is 'Optimistic version shared by manual maintenance and official imports.';
comment on table private.client_management_commands is
  'Private canonical results for idempotent manual client commands; never exposed directly.';
reset role;
comment on column api.client_seller_scopes.managed_by_manual_maintenance is
  'True only for seller scopes owned by the audited manual client-maintenance flow.';

revoke create on schema api, private from cirne_route_executor;
do $membership$
begin
  execute pg_catalog.format('revoke cirne_route_executor from %I granted by current_user', current_user);
end
$membership$;

commit;
