begin;

do $preflight$
begin
  if to_regprocedure('api.get_administration_snapshot()') is not null
     or to_regprocedure('api.update_administration_user(uuid,jsonb,text)') is not null
     or to_regclass('private.administration_commands') is not null
     or exists (select 1 from pg_catalog.pg_roles where rolname = 'cirne_administration_executor') then
    raise exception 'Administration essential objects already exist';
  end if;
  if to_regprocedure('private.resolve_current_identity()') is null
     or to_regclass('private.audit_events') is null
     or to_regclass('api.parameter_values') is null then
    raise exception 'Administration essential requires identity, audit and parameter foundations';
  end if;
end
$preflight$;

create role cirne_administration_executor
  nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;

do $membership$
begin
  execute pg_catalog.format('grant cirne_administration_executor to %I with set true granted by current_user', current_user);
  execute pg_catalog.format('grant cirne_identity_executor to %I with set true granted by current_user', current_user);
  execute pg_catalog.format('grant cirne_visit_executor to %I with set true granted by current_user', current_user);
  execute pg_catalog.format('grant cirne_sync_executor to %I with set true granted by current_user', current_user);
end
$membership$;

grant usage on schema api, private, extensions to cirne_administration_executor;
grant create on schema api, private to cirne_administration_executor;
grant select, update on api.user_profiles to cirne_administration_executor;
grant references on api.user_profiles to cirne_administration_executor;
grant select on api.roles, api.role_permissions, api.parameter_sets, api.parameter_values to cirne_administration_executor;
grant select, insert, update on api.user_role_assignments, api.user_seller_scopes to cirne_administration_executor;
grant select, insert on private.audit_events to cirne_administration_executor;

create policy user_profiles_administration_executor_all on api.user_profiles
  for all to cirne_administration_executor using (true) with check (true);
create policy roles_administration_executor_read on api.roles
  for select to cirne_administration_executor using (true);
create policy role_permissions_administration_executor_read on api.role_permissions
  for select to cirne_administration_executor using (true);
create policy user_role_assignments_administration_executor_all on api.user_role_assignments
  for all to cirne_administration_executor using (true) with check (true);
create policy user_seller_scopes_administration_executor_all on api.user_seller_scopes
  for all to cirne_administration_executor using (true) with check (true);
set local role cirne_visit_executor;
create policy parameter_sets_administration_executor_read on api.parameter_sets
  for select to cirne_administration_executor using (true);
create policy parameter_values_administration_executor_read on api.parameter_values
  for select to cirne_administration_executor using (true);
reset role;
set local role cirne_sync_executor;
create policy audit_events_administration_executor_read on private.audit_events
  for select to cirne_administration_executor using (true);
create policy audit_events_administration_executor_insert on private.audit_events
  for insert to cirne_administration_executor with check (true);
reset role;

set local role cirne_administration_executor;

create table private.administration_commands (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references api.user_profiles(id) on delete restrict,
  idempotency_key uuid not null,
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  target_user_id uuid not null references api.user_profiles(id) on delete restrict,
  canonical_result jsonb not null,
  created_at timestamptz not null default now(),
  unique (actor_id, idempotency_key)
);

revoke all on private.administration_commands from public, anon, authenticated;
grant select, insert on private.administration_commands to cirne_administration_executor;

create function private.administration_identity()
returns jsonb language plpgsql stable security definer set search_path = '' as $function$
declare identity_document jsonb := private.resolve_current_identity();
begin
  if identity_document is null
     or not (identity_document -> 'roles' ? 'administrator')
     or not (identity_document -> 'capabilities' ? 'identity.manage') then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;
  return identity_document;
end
$function$;

create function private.administration_user_document(p_user_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $function$
  select jsonb_build_object(
    'id', profile.id,
    'displayName', profile.display_name,
    'status', profile.status,
    'blockedAt', profile.blocked_at,
    'updatedAt', profile.updated_at,
    'roles', coalesce((
      select jsonb_agg(role_row.code order by role_row.code)
      from api.user_role_assignments assignment
      join api.roles role_row on role_row.id = assignment.role_id
      where assignment.user_id = profile.id and assignment.revoked_at is null
    ), '[]'::jsonb),
    'sellerScopeIds', case when exists (
      select 1 from api.user_role_assignments assignment
      join api.roles role_row on role_row.id = assignment.role_id
      where assignment.user_id = profile.id and assignment.revoked_at is null and role_row.code = 'manager'
    ) then coalesce((
      select jsonb_agg(scope.seller_user_id order by scope.seller_user_id)
      from api.user_seller_scopes scope
      where scope.manager_user_id = profile.id and scope.revoked_at is null
    ), '[]'::jsonb) else '[]'::jsonb end,
    'lastAdministrativeChange', (
      select jsonb_build_object(
        'action', event.action, 'reason', event.reason, 'occurredAt', event.occurred_at
      )
      from private.audit_events event
      where event.target_type = 'user_profile' and event.target_id = profile.id
        and event.action = 'identity.access.updated.v1' and event.reason is not null
      order by event.occurred_at desc, event.id desc limit 1
    )
  )
  from api.user_profiles profile where profile.id = p_user_id;
$function$;

create function private.administration_command_valid(p_command jsonb)
returns boolean language sql immutable set search_path = '' as $function$
  select jsonb_typeof(p_command) = 'object'
    and (select count(*) from jsonb_object_keys(p_command)) = 7
    and p_command ?& array['schemaVersion','expectedUpdatedAt','status','roles','sellerScopeIds','reason','idempotencyKey']
    and p_command ->> 'schemaVersion' = '1'
    and p_command ->> 'status' in ('active','inactive')
    and jsonb_typeof(p_command -> 'roles') = 'array'
    and jsonb_array_length(p_command -> 'roles') between 1 and 4
    and not exists (
      select 1 from jsonb_array_elements_text(p_command -> 'roles') role_code
      where role_code not in ('seller','manager','administrator','logistics')
    )
    and (select count(*) from jsonb_array_elements_text(p_command -> 'roles')) =
      (select count(distinct role_code) from jsonb_array_elements_text(p_command -> 'roles') role_code)
    and jsonb_typeof(p_command -> 'sellerScopeIds') = 'array'
    and jsonb_array_length(p_command -> 'sellerScopeIds') <= 500
    and ((p_command -> 'roles') ? 'manager' or jsonb_array_length(p_command -> 'sellerScopeIds') = 0)
    and char_length(btrim(p_command ->> 'reason')) between 10 and 500
    and (p_command ->> 'idempotencyKey') ~
      '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
    and (p_command ->> 'expectedUpdatedAt') ~
      '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'
    and not exists (
      select 1 from jsonb_array_elements_text(p_command -> 'sellerScopeIds') scope_id
      where scope_id !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
    )
    and (select count(*) from jsonb_array_elements_text(p_command -> 'sellerScopeIds')) =
      (select count(distinct lower(scope_id)) from jsonb_array_elements_text(p_command -> 'sellerScopeIds') scope_id);
$function$;

create function api.get_administration_snapshot()
returns jsonb language plpgsql stable security definer set search_path = '' as $function$
declare
  identity_document jsonb := private.administration_identity();
  current_parameter_set api.parameter_sets%rowtype;
begin
  select * into current_parameter_set from api.parameter_sets parameter_set
  where parameter_set.status = 'published'
  order by parameter_set.version desc limit 1;

  return jsonb_build_object(
    'schemaVersion', 1,
    'generatedAt', statement_timestamp(),
    'users', coalesce((
      select jsonb_agg(private.administration_user_document(profile.id)
        order by profile.display_name, profile.id)
      from api.user_profiles profile
      where exists (
        select 1 from api.user_role_assignments assignment
        where assignment.user_id = profile.id and assignment.revoked_at is null
      )
    ), '[]'::jsonb),
    'roles', coalesce((
      select jsonb_agg(jsonb_build_object('code', role_row.code, 'name', role_row.name)
        order by role_row.name, role_row.code) from api.roles role_row
    ), '[]'::jsonb),
    'parameters', jsonb_build_object(
      'mutationAvailability', 'blocked_pending_business_approval',
      'blockers', jsonb_build_array('AB-02','AB-03','AB-09'),
      'current', case when current_parameter_set.id is null then null else jsonb_build_object(
        'parameterSetId', current_parameter_set.id,
        'version', current_parameter_set.version,
        'validFrom', current_parameter_set.valid_from,
        'values', coalesce((select jsonb_agg(jsonb_build_object(
          'id', value.id, 'category', value.category, 'code', value.code,
          'label', value.label, 'sortOrder', value.sort_order
        ) order by value.category, value.sort_order, value.id)
        from api.parameter_values value where value.parameter_set_id = current_parameter_set.id), '[]'::jsonb)
      ) end
    )
  );
end
$function$;

create function api.update_administration_user(
  p_user_id uuid, p_command jsonb, p_origin text default 'web'
) returns jsonb language plpgsql volatile security definer set search_path = '' as $function$
declare
  identity_document jsonb := private.administration_identity();
  v_actor_id uuid := (identity_document ->> 'id')::uuid;
  key_value uuid;
  payload_hash text;
  existing_command private.administration_commands%rowtype;
  target_profile api.user_profiles%rowtype;
  before_document jsonb;
  after_document jsonb;
  result_document jsonb;
  expected_updated_at timestamptz;
  role_count integer;
  requested_role_count integer;
  scope_count integer;
  requested_scope_count integer;
begin
  if p_user_id is null or p_origin not in ('web','cli')
     or not coalesce(private.administration_command_valid(p_command), false) then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  if p_user_id = v_actor_id then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;
  key_value := (p_command ->> 'idempotencyKey')::uuid;
  expected_updated_at := (p_command ->> 'expectedUpdatedAt')::timestamptz;
  payload_hash := encode(extensions.digest(convert_to(
    jsonb_build_object('userId',p_user_id,'command',p_command)::text,'UTF8'),'sha256'),'hex');

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    v_actor_id::text || ':identity.access.updated.v1:' || key_value::text, 0));
  select * into existing_command from private.administration_commands command
  where command.actor_id = v_actor_id and command.idempotency_key = key_value;
  if found then
    if existing_command.payload_hash <> payload_hash then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return jsonb_set(existing_command.canonical_result, '{replayed}', 'true'::jsonb);
  end if;

  select * into target_profile from api.user_profiles profile where profile.id = p_user_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'NOT_FOUND'; end if;
  before_document := private.administration_user_document(p_user_id);
  if target_profile.updated_at <> expected_updated_at then
    raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT',
      detail = jsonb_build_object('current', before_document)::text;
  end if;

  select count(*)::integer into requested_role_count from jsonb_array_elements_text(p_command -> 'roles');
  select count(*)::integer into role_count from api.roles role_row
  where role_row.code in (select jsonb_array_elements_text(p_command -> 'roles'));
  if role_count <> requested_role_count then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;

  select count(*)::integer into requested_scope_count
  from jsonb_array_elements_text(p_command -> 'sellerScopeIds');
  select count(*)::integer into scope_count from api.user_profiles seller
  where seller.id in (select value::uuid from jsonb_array_elements_text(p_command -> 'sellerScopeIds') value)
    and (
      exists (
        select 1 from api.user_seller_scopes existing_scope
        where existing_scope.manager_user_id = p_user_id
          and existing_scope.seller_user_id = seller.id and existing_scope.revoked_at is null
      ) or (
        seller.status = 'active' and seller.blocked_at is null and exists (
          select 1 from api.user_role_assignments assignment
          join api.roles role_row on role_row.id = assignment.role_id and role_row.code = 'seller'
          where assignment.user_id = seller.id and assignment.revoked_at is null
        )
      )
    );
  if scope_count <> requested_scope_count then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'identity.active-administrator-set', 0));
  if exists (
      select 1 from api.user_role_assignments assignment
      join api.roles role_row on role_row.id = assignment.role_id and role_row.code = 'administrator'
      where assignment.user_id = p_user_id and assignment.revoked_at is null
    ) and ((p_command ->> 'status') = 'inactive' or not (p_command -> 'roles' ? 'administrator'))
    and not exists (
      select 1 from api.user_profiles other_profile
      join api.user_role_assignments other_assignment on other_assignment.user_id = other_profile.id
        and other_assignment.revoked_at is null
      join api.roles other_role on other_role.id = other_assignment.role_id and other_role.code = 'administrator'
      where other_profile.id <> p_user_id and other_profile.status = 'active' and other_profile.blocked_at is null
    ) then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;

  update api.user_profiles set
    status = p_command ->> 'status',
    blocked_at = case when p_command ->> 'status' = 'inactive' then coalesce(blocked_at, statement_timestamp()) else null end
  where id = p_user_id;

  update api.user_role_assignments assignment set revoked_at = statement_timestamp()
  from api.roles role_row
  where assignment.user_id = p_user_id and assignment.role_id = role_row.id
    and assignment.revoked_at is null and not (p_command -> 'roles' ? role_row.code);
  insert into api.user_role_assignments (user_id, role_id, assigned_by)
  select p_user_id, role_row.id, v_actor_id from api.roles role_row
  where p_command -> 'roles' ? role_row.code and not exists (
    select 1 from api.user_role_assignments assignment
    where assignment.user_id = p_user_id and assignment.role_id = role_row.id and assignment.revoked_at is null
  );

  update api.user_seller_scopes scope set revoked_at = statement_timestamp()
  where scope.manager_user_id = p_user_id and scope.revoked_at is null
    and (not (p_command -> 'roles' ? 'manager')
      or not (p_command -> 'sellerScopeIds' ? scope.seller_user_id::text));
  insert into api.user_seller_scopes (manager_user_id, seller_user_id)
  select p_user_id, value::uuid from jsonb_array_elements_text(p_command -> 'sellerScopeIds') value
  where not exists (
    select 1 from api.user_seller_scopes scope
    where scope.manager_user_id = p_user_id and scope.seller_user_id = value::uuid and scope.revoked_at is null
  );

  after_document := private.administration_user_document(p_user_id);
  insert into private.audit_events (
    actor_id, target_type, target_id, action, before_data, after_data, reason, origin, request_id
  ) values (
    v_actor_id, 'user_profile', p_user_id, 'identity.access.updated.v1', before_document,
    after_document, btrim(p_command ->> 'reason'), p_origin, key_value
  );
  result_document := jsonb_build_object(
    'schemaVersion', 1, 'replayed', false,
    'user', private.administration_user_document(p_user_id)
  );
  insert into private.administration_commands (
    actor_id, idempotency_key, payload_hash, target_user_id, canonical_result
  ) values (v_actor_id, key_value, payload_hash, p_user_id, result_document);
  return result_document;
end
$function$;

comment on function api.get_administration_snapshot() is
  'Projeta perfis e parâmetros mínimos exclusivamente ao Administrador ativo.';
comment on function api.update_administration_user(uuid,jsonb,text) is
  'Atualiza acesso de perfil existente com concorrência, idempotência e auditoria.';

revoke all on function private.administration_identity(),
  private.administration_user_document(uuid), private.administration_command_valid(jsonb),
  api.get_administration_snapshot(), api.update_administration_user(uuid,jsonb,text)
  from public, anon, authenticated;
grant execute on function api.get_administration_snapshot(),
  api.update_administration_user(uuid,jsonb,text) to authenticated;

reset role;
revoke create on schema api, private from cirne_administration_executor;

set local role cirne_identity_executor;
grant execute on function private.resolve_current_identity() to cirne_administration_executor;
reset role;

do $ownership$
begin
  execute pg_catalog.format('revoke cirne_identity_executor from %I granted by current_user', current_user);
  execute pg_catalog.format('revoke cirne_visit_executor from %I granted by current_user', current_user);
  execute pg_catalog.format('revoke cirne_sync_executor from %I granted by current_user', current_user);
  execute pg_catalog.format('revoke cirne_administration_executor from %I granted by current_user', current_user);
end
$ownership$;

commit;
