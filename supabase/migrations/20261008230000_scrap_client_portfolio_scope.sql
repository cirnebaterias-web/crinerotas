-- Story 3.10 QA fix: fail closed for standalone scrap scheduling.
-- A client must be explicitly assigned to the seller portfolio. Route-backed
-- schedules remain authorized by the visit/route chain already checked by the RPC.
begin;

select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cirne:database:migrate'));
set local lock_timeout = '5s';

create table api.client_seller_scopes (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references api.clients(id) on delete restrict,
  seller_id uuid not null references api.user_profiles(id) on delete restrict,
  assigned_by uuid references api.user_profiles(id) on delete restrict,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index client_seller_scopes_active_key
  on api.client_seller_scopes (client_id, seller_id)
  where revoked_at is null;
create index client_seller_scopes_seller_client_idx
  on api.client_seller_scopes (seller_id, client_id)
  where revoked_at is null;

alter table api.client_seller_scopes enable row level security;
alter table api.client_seller_scopes force row level security;
revoke all on api.client_seller_scopes from public, anon, authenticated;
grant select on api.client_seller_scopes to cirne_scrap_executor;
grant select, insert, update on api.client_seller_scopes to service_role;
create policy client_seller_scopes_scrap_read
  on api.client_seller_scopes
  for select
  to cirne_scrap_executor
  using (true);

do $membership$
begin
  execute format(
    'grant cirne_scrap_executor to %I with set true granted by current_user',
    current_user
  );
end
$membership$;

grant create on schema api, private to cirne_scrap_executor;

set local role cirne_scrap_executor;

create function private.scrap_client_authorized(
  p_seller_id uuid,
  p_client_id uuid
) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from api.client_seller_scopes scope_row
    where scope_row.seller_id = p_seller_id
      and scope_row.client_id = p_client_id
      and scope_row.revoked_at is null
  );
$$;

create function private.enforce_scrap_schedule_client_scope()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.origin = 'standalone'
     and not private.scrap_client_authorized(new.seller_id, new.client_id) then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;
  return new;
end;
$$;

create or replace function api.search_scrap_clients(
  p_query text default '',
  p_limit integer default 30
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  identity_document jsonb := private.scrap_identity('scrap.schedule_self');
  actor_id uuid := (identity_document ->> 'id')::uuid;
begin
  if length(trim(p_query)) < 2 then
    return '[]';
  end if;

  return coalesce((
    select jsonb_agg(
      jsonb_build_object('id', id, 'name', name, 'address', address)
      order by name
    )
    from (
      select client.id, client.name, client.address
      from api.clients client
      where client.status = 'active'
        and client.archived_at is null
        and private.scrap_client_authorized(actor_id, client.id)
        and (
          client.name ilike '%' || replace(replace(replace(trim(p_query), '\', '\\'), '%', '\%'), '_', '\_') || '%'
          or client.external_reference = trim(p_query)
        )
      order by client.name
      limit least(greatest(p_limit, 1), 30)
    ) authorized_clients
  ), '[]');
end;
$$;

revoke all on function private.scrap_client_authorized(uuid, uuid),
  private.enforce_scrap_schedule_client_scope()
  from public, anon, authenticated;

reset role;

revoke create on schema api, private from cirne_scrap_executor;

create trigger enforce_scrap_schedule_client_scope
before insert or update of client_id, seller_id, origin
on api.pickup_schedules
for each row execute function private.enforce_scrap_schedule_client_scope();

do $membership$
begin
  execute format(
    'revoke cirne_scrap_executor from %I granted by current_user',
    current_user
  );
end
$membership$;

comment on table api.client_seller_scopes is
  'Explicit seller portfolio authorization for standalone client operations; maintained by controlled client imports.';

commit;
