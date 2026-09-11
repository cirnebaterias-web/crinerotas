begin;

do $preflight$
begin
  if exists (select 1 from pg_catalog.pg_namespace where nspname in ('api', 'private')) then
    raise exception 'Identity foundation expects api/private schemas to be absent';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'cirne_identity_executor') then
    raise exception 'Identity foundation expects cirne_identity_executor role to be absent';
  end if;
end
$preflight$;

create schema api;
create schema private;
create role cirne_identity_executor
  nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;

revoke all on schema api from public;
revoke all on schema private from public;
revoke all on schema api from anon;
revoke all on schema private from anon;

create table api.user_profiles (
  id uuid primary key references auth.users(id) on delete restrict,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 120),
  status text not null default 'active' check (status in ('active', 'inactive')),
  blocked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_profiles_blocked_status_check
    check (blocked_at is null or status = 'inactive')
);

create table api.roles (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code in ('seller', 'manager', 'administrator')),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table api.role_permissions (
  id uuid primary key default gen_random_uuid(),
  role_id uuid not null references api.roles(id) on delete restrict,
  permission_code text not null check (permission_code ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint role_permissions_role_permission_key unique (role_id, permission_code)
);

create table api.user_role_assignments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references api.user_profiles(id) on delete restrict,
  role_id uuid not null references api.roles(id) on delete restrict,
  assigned_by uuid not null references api.user_profiles(id) on delete restrict,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table api.user_seller_scopes (
  id uuid primary key default gen_random_uuid(),
  manager_user_id uuid not null references api.user_profiles(id) on delete restrict,
  seller_user_id uuid not null references api.user_profiles(id) on delete restrict,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_seller_scopes_distinct_users_check check (manager_user_id <> seller_user_id)
);

create unique index user_role_assignments_active_key
  on api.user_role_assignments (user_id, role_id)
  where revoked_at is null;
create index user_role_assignments_user_id_idx on api.user_role_assignments (user_id);
create index user_role_assignments_role_id_idx on api.user_role_assignments (role_id);
create index user_role_assignments_assigned_by_idx on api.user_role_assignments (assigned_by);

create unique index user_seller_scopes_active_key
  on api.user_seller_scopes (manager_user_id, seller_user_id)
  where revoked_at is null;
create index user_seller_scopes_manager_user_id_idx on api.user_seller_scopes (manager_user_id);
create index user_seller_scopes_seller_user_id_idx on api.user_seller_scopes (seller_user_id);
create index role_permissions_role_id_idx on api.role_permissions (role_id);

create function private.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  new.updated_at = now();
  return new;
end
$function$;

create trigger user_profiles_set_updated_at
before update on api.user_profiles
for each row execute function private.set_updated_at();
create trigger roles_set_updated_at
before update on api.roles
for each row execute function private.set_updated_at();
create trigger role_permissions_set_updated_at
before update on api.role_permissions
for each row execute function private.set_updated_at();
create trigger user_role_assignments_set_updated_at
before update on api.user_role_assignments
for each row execute function private.set_updated_at();
create trigger user_seller_scopes_set_updated_at
before update on api.user_seller_scopes
for each row execute function private.set_updated_at();

insert into api.roles (id, code, name)
values
  ('00000000-0000-4000-8000-000000000001', 'seller', 'Vendedor'),
  ('00000000-0000-4000-8000-000000000002', 'manager', 'Gestor'),
  ('00000000-0000-4000-8000-000000000003', 'administrator', 'Administrador')
on conflict (code) do update set name = excluded.name;

insert into api.role_permissions (role_id, permission_code)
values
  ('00000000-0000-4000-8000-000000000001', 'identity.read_self'),
  ('00000000-0000-4000-8000-000000000002', 'identity.read_self'),
  ('00000000-0000-4000-8000-000000000003', 'identity.read_self'),
  ('00000000-0000-4000-8000-000000000003', 'identity.manage')
on conflict (role_id, permission_code) do nothing;

alter table api.user_profiles enable row level security;
alter table api.user_profiles force row level security;
alter table api.roles enable row level security;
alter table api.roles force row level security;
alter table api.role_permissions enable row level security;
alter table api.role_permissions force row level security;
alter table api.user_role_assignments enable row level security;
alter table api.user_role_assignments force row level security;
alter table api.user_seller_scopes enable row level security;
alter table api.user_seller_scopes force row level security;

create policy user_profiles_read_self
on api.user_profiles for select to authenticated
using (
  (select auth.uid()) is not null
  and id = (select auth.uid())
  and status = 'active'
  and blocked_at is null
);

create policy user_profiles_identity_executor_read
on api.user_profiles for select to cirne_identity_executor using (true);
create policy roles_identity_executor_read
on api.roles for select to cirne_identity_executor using (true);
create policy role_permissions_identity_executor_read
on api.role_permissions for select to cirne_identity_executor using (true);
create policy user_role_assignments_identity_executor_read
on api.user_role_assignments for select to cirne_identity_executor using (true);
create policy user_seller_scopes_identity_executor_read
on api.user_seller_scopes for select to cirne_identity_executor using (true);

grant usage on schema api to authenticated, service_role, cirne_identity_executor;
grant create on schema api to cirne_identity_executor;
grant usage, create on schema private to cirne_identity_executor;
grant select on api.user_profiles to authenticated;
grant select on api.user_profiles, api.roles, api.role_permissions,
  api.user_role_assignments, api.user_seller_scopes to cirne_identity_executor;
grant select on api.roles, api.role_permissions to service_role;
grant select, insert, update on api.user_profiles, api.user_role_assignments,
  api.user_seller_scopes to service_role;

create function private.resolve_current_identity()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  actor_id_text text := coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  );
  actor_id uuid;
  identity_document jsonb;
begin
  if actor_id_text is null or actor_id_text !~
      '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    return null;
  end if;
  actor_id := actor_id_text::uuid;

  select jsonb_build_object(
    'id', profile.id,
    'displayName', profile.display_name,
    'roles', coalesce((
      select jsonb_agg(active_roles.code order by active_roles.code)
      from (
        select distinct role_row.code
        from api.user_role_assignments assignment
        join api.roles role_row on role_row.id = assignment.role_id
        where assignment.user_id = profile.id and assignment.revoked_at is null
      ) active_roles
    ), '[]'::jsonb),
    'capabilities', coalesce((
      select jsonb_agg(active_permissions.permission_code order by active_permissions.permission_code)
      from (
        select distinct permission.permission_code
        from api.user_role_assignments assignment
        join api.role_permissions permission on permission.role_id = assignment.role_id
        where assignment.user_id = profile.id and assignment.revoked_at is null
      ) active_permissions
    ), '[]'::jsonb),
    'scopeIds', coalesce((
      select jsonb_agg(active_scopes.scope_id order by active_scopes.scope_id)
      from (
        select profile.id as scope_id
        where exists (
          select 1
          from api.user_role_assignments assignment
          join api.roles role_row on role_row.id = assignment.role_id
          where assignment.user_id = profile.id
            and assignment.revoked_at is null
            and role_row.code = 'seller'
        )
        union
        select scope.seller_user_id
        from api.user_seller_scopes scope
        join api.user_profiles seller_profile on seller_profile.id = scope.seller_user_id
        where scope.manager_user_id = profile.id
          and scope.revoked_at is null
          and seller_profile.status = 'active'
          and seller_profile.blocked_at is null
          and exists (
            select 1
            from api.user_role_assignments manager_assignment
            join api.roles manager_role on manager_role.id = manager_assignment.role_id
            where manager_assignment.user_id = profile.id
              and manager_assignment.revoked_at is null
              and manager_role.code = 'manager'
          )
          and exists (
            select 1
            from api.user_role_assignments seller_assignment
            join api.roles seller_role on seller_role.id = seller_assignment.role_id
            where seller_assignment.user_id = seller_profile.id
              and seller_assignment.revoked_at is null
              and seller_role.code = 'seller'
          )
      ) active_scopes
    ), '[]'::jsonb),
    'status', profile.status
  )
  into identity_document
  from api.user_profiles profile
  where profile.id = actor_id
    and profile.status = 'active'
    and profile.blocked_at is null
    and exists (
      select 1
      from api.user_role_assignments assignment
      join api.role_permissions permission on permission.role_id = assignment.role_id
      where assignment.user_id = profile.id
        and assignment.revoked_at is null
        and permission.permission_code = 'identity.read_self'
    );

  return identity_document;
end
$function$;

create function api.get_my_identity()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select private.resolve_current_identity();
$function$;
comment on function api.get_my_identity() is 'Retorna somente o contexto vigente do chamador autenticado.';

do $ownership$
begin
  execute pg_catalog.format(
    'grant cirne_identity_executor to %I',
    current_user
  );
end
$ownership$;
alter function private.resolve_current_identity() owner to cirne_identity_executor;
alter function api.get_my_identity() owner to cirne_identity_executor;
revoke create on schema api from cirne_identity_executor;
revoke create on schema private from cirne_identity_executor;

set local role cirne_identity_executor;
revoke all on function private.resolve_current_identity() from public, anon, authenticated;
revoke all on function api.get_my_identity() from public, anon;
grant execute on function api.get_my_identity() to authenticated;
reset role;

do $ownership$
begin
  execute pg_catalog.format('revoke cirne_identity_executor from %I', current_user);
end
$ownership$;

alter default privileges in schema api revoke all on tables from public, anon, authenticated;
alter default privileges in schema api revoke execute on functions from public, anon, authenticated;
alter default privileges in schema private revoke all on tables from public, anon, authenticated;
alter default privileges in schema private revoke execute on functions from public, anon, authenticated;

comment on schema api is 'Superficie deliberadamente exposta pela Data API do Cirne Rotas.';
comment on schema private is 'Objetos internos; nunca expor na configuracao da Data API.';

commit;
