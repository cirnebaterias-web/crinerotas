begin;
select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cirne:database:migrate'));

insert into api.role_permissions(role_id,permission_code)
select role_row.id,'products.sync'
from api.roles role_row
where role_row.code='administrator'
on conflict (role_id,permission_code) do nothing;

insert into private.product_catalog_sources(source_key,sync_actor_id)
values(
  '8409a98d286f96b831d5f132e3292877fb1532e1e203b449d2c248de5392a2d6',
  '49ca85cf-0fe1-46ca-8097-eef7e443c6b7'
)
on conflict (source_key) do update
set sync_actor_id=excluded.sync_actor_id,updated_at=clock_timestamp();

commit;
