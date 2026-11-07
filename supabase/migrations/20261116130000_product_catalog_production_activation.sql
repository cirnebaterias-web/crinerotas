begin;
select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cirne:database:migrate'));

insert into api.role_permissions(role_id,permission_code)
select role_row.id,'products.sync'
from api.roles role_row
where role_row.code='administrator'
  and exists (
    select 1
    from api.user_profiles profile
    join api.user_role_assignments assignment
      on assignment.user_id = profile.id
      and assignment.role_id = role_row.id
      and assignment.revoked_at is null
    where profile.id = '49ca85cf-0fe1-46ca-8097-eef7e443c6b7'
      and profile.status = 'active'
      and profile.blocked_at is null
  )
on conflict (role_id,permission_code) do nothing;

-- This binding is intentionally production-specific. Clean and synthetic
-- environments do not contain the approved operator and must stay unbound
-- instead of inventing a privileged identity or failing the schema bootstrap.
insert into private.product_catalog_sources(source_key,sync_actor_id)
select
  '8409a98d286f96b831d5f132e3292877fb1532e1e203b449d2c248de5392a2d6',
  profile.id
from api.user_profiles profile
where profile.id = '49ca85cf-0fe1-46ca-8097-eef7e443c6b7'
  and profile.status = 'active'
  and profile.blocked_at is null
  and exists (
    select 1
    from api.user_role_assignments assignment
    join api.roles role_row on role_row.id = assignment.role_id
    where assignment.user_id = profile.id
      and assignment.revoked_at is null
      and role_row.code = 'administrator'
  )
on conflict (source_key) do update
set sync_actor_id=excluded.sync_actor_id,updated_at=clock_timestamp();

commit;
