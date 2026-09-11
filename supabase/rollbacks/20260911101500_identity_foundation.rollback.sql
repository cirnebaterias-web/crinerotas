begin;

do $rollback$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'cirne_identity_executor') then
    execute pg_catalog.format('grant cirne_identity_executor to %I', current_user);
  end if;
end
$rollback$;

drop function if exists api.get_my_identity();
drop function if exists private.resolve_current_identity();
drop table if exists api.user_seller_scopes;
drop table if exists api.user_role_assignments;
drop table if exists api.role_permissions;
drop table if exists api.roles;
drop table if exists api.user_profiles;
drop function if exists private.set_updated_at();
drop schema if exists private;
do $rollback$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'cirne_identity_executor') then
    execute pg_catalog.format('revoke cirne_identity_executor from %I', current_user);
    execute 'revoke usage on schema api from cirne_identity_executor';
    execute 'drop role cirne_identity_executor';
  end if;
end
$rollback$;

-- `api` permanece vazio enquanto estiver listado em config.toml. Depois de
-- restaurar schemas = ["public", "graphql_public"] e reiniciar a Data API,
-- ele pode ser removido com: drop schema api;

commit;
