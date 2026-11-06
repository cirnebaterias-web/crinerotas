-- Story 4.19: versioned seller route profile and effective offboarding.
begin;

select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cirne:database:migrate'));
set local lock_timeout = '5s';

do $preflight$
begin
  if to_regclass('api.seller_route_profiles') is not null
     or to_regprocedure('api.get_seller_route_profile(uuid)') is not null
     or to_regprocedure('api.update_seller_route_profile(uuid,jsonb,text)') is not null then
    raise exception 'Seller route profile objects already exist';
  end if;
end
$preflight$;

grant create on schema api, private to cirne_administration_executor;
grant select on api.client_seller_scopes to cirne_administration_executor;

do $membership$
begin
  execute pg_catalog.format('grant cirne_identity_executor to %I with set true granted by current_user', current_user);
  execute pg_catalog.format('grant cirne_administration_executor to %I with set true granted by current_user', current_user);
end
$membership$;
set local role cirne_identity_executor;
grant execute on function private.resolve_current_identity() to cirne_administration_executor;
reset role;

set local role cirne_administration_executor;

create table api.seller_route_profiles (
  seller_id uuid primary key references api.user_profiles(id) on delete restrict,
  base_city text,
  base_state text,
  base_ibge_code text,
  base_latitude double precision,
  base_longitude double precision,
  offboarding_at timestamptz,
  version integer not null default 1 check (version > 0),
  updated_by uuid not null references api.user_profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint seller_route_profiles_city_complete check (
    (base_city is null and base_state is null and base_ibge_code is null
      and base_latitude is null and base_longitude is null)
    or
    (char_length(btrim(base_city)) between 2 and 120 and base_state ~ '^[A-Z]{2}$'
      and base_ibge_code ~ '^[0-9]{7}$' and base_latitude between -90 and 90
      and base_longitude between -180 and 180)
  )
);

create trigger seller_route_profiles_set_updated_at before update on api.seller_route_profiles
for each row execute function private.set_updated_at();

alter table api.seller_route_profiles enable row level security;
alter table api.seller_route_profiles force row level security;
revoke all on api.seller_route_profiles from public, anon, authenticated;
grant select, insert, update on api.seller_route_profiles to cirne_administration_executor;
create policy seller_route_profiles_administration_executor_all on api.seller_route_profiles
  for all to cirne_administration_executor using (true) with check (true);

create table private.seller_route_profile_commands (
  actor_id uuid not null references api.user_profiles(id) on delete restrict,
  idempotency_key uuid not null,
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  canonical_result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (actor_id, idempotency_key)
);
revoke all on private.seller_route_profile_commands from public, anon, authenticated;
grant select, insert on private.seller_route_profile_commands to cirne_administration_executor;

create function private.seller_route_profile_identity(p_seller_id uuid, p_write boolean)
returns jsonb language plpgsql stable security definer set search_path = '' as $function$
declare identity_document jsonb := private.resolve_current_identity();
begin
  if identity_document is null then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;
  if identity_document -> 'roles' ? 'administrator'
     and identity_document -> 'capabilities' ? 'identity.manage' then
    return identity_document;
  end if;
  if identity_document -> 'roles' ? 'manager'
     and identity_document -> 'capabilities' ? 'route.plan_scoped'
     and identity_document -> 'scopeIds' ? p_seller_id::text then
    return identity_document;
  end if;
  raise exception using errcode = 'P0001', message = 'FORBIDDEN';
end
$function$;

create function private.seller_route_profile_document(p_seller_id uuid, p_at timestamptz default statement_timestamp())
returns jsonb language sql stable security definer set search_path = '' as $function$
  select jsonb_build_object(
    'schemaVersion', 1, 'sellerId', seller.id, 'displayName', seller.display_name,
    'lifecycle', case when profile.offboarding_at is null then 'active'
      when profile.offboarding_at > p_at then 'offboarding_scheduled' else 'inactive' end,
    'offboardingAt', profile.offboarding_at,
    'baseCity', case when profile.base_city is null then null else jsonb_build_object(
      'city', profile.base_city, 'state', profile.base_state, 'ibgeCode', profile.base_ibge_code,
      'latitude', profile.base_latitude, 'longitude', profile.base_longitude,
      'reference', 'municipal_seat', 'source', 'IBGE') end,
    'portfolioState', case when profile.offboarding_at is not null and profile.offboarding_at <= p_at
      then 'unassigned' else 'assigned' end,
    'version', coalesce(profile.version, 0), 'updatedAt', coalesce(profile.updated_at, seller.updated_at)
  )
  from api.user_profiles seller
  left join api.seller_route_profiles profile on profile.seller_id = seller.id
  where seller.id = p_seller_id and exists (
    select 1 from api.user_role_assignments assignment join api.roles role_row on role_row.id = assignment.role_id
    where assignment.user_id = seller.id and assignment.revoked_at is null and role_row.code = 'seller'
  );
$function$;

create function api.get_seller_route_profile(p_seller_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $function$
declare identity_document jsonb := private.seller_route_profile_identity(p_seller_id, false);
declare result jsonb;
begin
  select private.seller_route_profile_document(p_seller_id) into result;
  if result is null then raise exception using errcode = 'P0001', message = 'NOT_FOUND'; end if;
  return result;
end
$function$;

create function api.update_seller_route_profile(p_seller_id uuid, p_command jsonb, p_origin text default 'web')
returns jsonb language plpgsql volatile security definer set search_path = '' as $function$
#variable_conflict use_variable
declare identity_document jsonb := private.seller_route_profile_identity(p_seller_id, true);
declare actor_id uuid := (identity_document ->> 'id')::uuid;
declare existing api.seller_route_profiles%rowtype;
declare stored private.seller_route_profile_commands%rowtype;
declare expected_version integer;
declare key_value uuid;
declare payload_hash text;
declare before_document jsonb;
declare after_document jsonb;
declare result_document jsonb;
declare city jsonb;
begin
  if p_origin not in ('web','cli') or jsonb_typeof(p_command) <> 'object'
     or (select count(*) from jsonb_object_keys(p_command)) <> 6
     or not p_command ?& array['schemaVersion','expectedVersion','offboardingAt','baseCity','reason','idempotencyKey']
     or p_command ->> 'schemaVersion' is distinct from '1'
     or char_length(btrim(p_command ->> 'reason')) not between 10 and 500
     or (p_command ->> 'idempotencyKey') !~ '^[0-9a-fA-F-]{36}$' then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  expected_version := (p_command ->> 'expectedVersion')::integer;
  if expected_version is null or expected_version < 0
     or jsonb_typeof(p_command -> 'expectedVersion') is distinct from 'number' then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED'; end if;
  key_value := (p_command ->> 'idempotencyKey')::uuid;
  city := p_command -> 'baseCity';
  if city <> 'null'::jsonb and (jsonb_typeof(city) <> 'object'
     or (select count(*) from jsonb_object_keys(city)) <> 7
     or not city ?& array['city','state','ibgeCode','latitude','longitude','reference','source']
     or city ->> 'reference' <> 'municipal_seat' or city ->> 'source' <> 'IBGE') then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  payload_hash := encode(extensions.digest(convert_to(
    jsonb_build_object('sellerId',p_seller_id,'command',p_command)::text,'UTF8'),'sha256'),'hex');
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    actor_id::text || ':seller.route-profile.updated.v1:' || key_value::text, 0));
  select * into stored from private.seller_route_profile_commands command
    where command.actor_id = actor_id and command.idempotency_key = key_value;
  if found then
    if stored.payload_hash <> payload_hash then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return jsonb_set(stored.canonical_result, '{replayed}', 'true'::jsonb);
  end if;
  select * into existing from api.seller_route_profiles profile where profile.seller_id = p_seller_id for update;
  if (found and existing.version <> expected_version) or (not found and expected_version <> 0) then
    raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT';
  end if;
  before_document := private.seller_route_profile_document(p_seller_id);
  insert into api.seller_route_profiles (seller_id, base_city, base_state, base_ibge_code,
    base_latitude, base_longitude, offboarding_at, version, updated_by)
  values (p_seller_id, city ->> 'city', city ->> 'state', city ->> 'ibgeCode',
    (city ->> 'latitude')::double precision, (city ->> 'longitude')::double precision,
    nullif(p_command ->> 'offboardingAt','')::timestamptz, 1, actor_id)
  on conflict (seller_id) do update set base_city = excluded.base_city, base_state = excluded.base_state,
    base_ibge_code = excluded.base_ibge_code, base_latitude = excluded.base_latitude,
    base_longitude = excluded.base_longitude, offboarding_at = excluded.offboarding_at,
    version = api.seller_route_profiles.version + 1, updated_by = actor_id;
  after_document := private.seller_route_profile_document(p_seller_id);
  insert into private.audit_events (actor_id,target_type,target_id,action,before_data,after_data,reason,origin,request_id)
  values (actor_id,'seller_route_profile',p_seller_id,'seller.route-profile.updated.v1',before_document,
    after_document,btrim(p_command ->> 'reason'),p_origin,key_value);
  result_document := jsonb_build_object('schemaVersion',1,'replayed',false,'profile',after_document);
  insert into private.seller_route_profile_commands(actor_id,idempotency_key,payload_hash,canonical_result)
  values(actor_id,key_value,payload_hash,result_document);
  return result_document;
exception when invalid_text_representation or numeric_value_out_of_range or datetime_field_overflow then
  raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
end
$function$;

revoke all on function private.seller_route_profile_identity(uuid,boolean),
  private.seller_route_profile_document(uuid,timestamptz), api.get_seller_route_profile(uuid),
  api.update_seller_route_profile(uuid,jsonb,text) from public, anon, authenticated;
grant execute on function api.get_seller_route_profile(uuid),
  api.update_seller_route_profile(uuid,jsonb,text) to authenticated;

comment on table api.seller_route_profiles is
  'Versioned operational city and effective offboarding; historical visits remain on their original seller.';

reset role;
revoke create on schema api, private from cirne_administration_executor;

do $membership$
begin
  execute pg_catalog.format('revoke cirne_identity_executor from %I granted by current_user', current_user);
  execute pg_catalog.format('revoke cirne_administration_executor from %I granted by current_user', current_user);
end
$membership$;

commit;
