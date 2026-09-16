begin;

do $rollback$
declare
  identity_effective_set_option boolean := false;
  identity_current_grant_exists boolean := false;
  identity_current_set_option boolean := false;
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'cirne_route_executor') then
    return;
  end if;

  select coalesce(bool_or(membership.set_option), false)
  into identity_effective_set_option
  from pg_catalog.pg_auth_members membership
  join pg_catalog.pg_roles granted_role on granted_role.oid = membership.roleid
  join pg_catalog.pg_roles member_role on member_role.oid = membership.member
  where granted_role.rolname = 'cirne_identity_executor'
    and member_role.rolname = current_user;

  select true, membership.set_option
  into identity_current_grant_exists, identity_current_set_option
  from pg_catalog.pg_auth_members membership
  join pg_catalog.pg_roles granted_role on granted_role.oid = membership.roleid
  join pg_catalog.pg_roles member_role on member_role.oid = membership.member
  join pg_catalog.pg_roles grantor_role on grantor_role.oid = membership.grantor
  where granted_role.rolname = 'cirne_identity_executor'
    and member_role.rolname = current_user
    and grantor_role.rolname = current_user;

  execute pg_catalog.format('grant cirne_route_executor to %I with set true granted by current_user', current_user);
  if not identity_effective_set_option then
    execute pg_catalog.format('grant cirne_identity_executor to %I with set true granted by current_user', current_user);
  end if;
  execute 'set local role cirne_identity_executor';
  execute 'revoke execute on function private.resolve_current_identity() from cirne_route_executor';
  execute 'reset role';
  if not identity_effective_set_option and coalesce(identity_current_grant_exists, false) then
    execute pg_catalog.format(
      'grant cirne_identity_executor to %I with set %s granted by current_user',
      current_user,
      case when identity_current_set_option then 'true' else 'false' end
    );
  elsif not identity_effective_set_option then
    execute pg_catalog.format('revoke cirne_identity_executor from %I granted by current_user', current_user);
  end if;
  execute pg_catalog.format('grant cirne_sync_executor to %I with set true granted by current_user', current_user);
  execute 'set local role cirne_sync_executor';
  execute 'revoke insert on table private.audit_events from cirne_route_executor';
  execute 'reset role';
  execute pg_catalog.format('revoke cirne_sync_executor from %I granted by current_user', current_user);

  execute 'drop function if exists api.get_my_route_for_date(date)';
  execute 'drop function if exists api.get_route(uuid)';
  execute 'drop function if exists api.publish_route(uuid, integer)';
  execute 'drop function if exists api.create_route_draft(jsonb)';
  execute 'drop function if exists private.get_my_route_for_date(date)';
  execute 'drop function if exists private.get_route(uuid)';
  execute 'drop function if exists private.build_route_document(uuid)';
  execute 'drop function if exists private.publish_route(uuid, integer)';
  execute 'drop function if exists private.create_route_draft(jsonb)';
  execute 'drop table if exists api.route_stop_executions';
  execute 'drop table if exists api.route_version_stops';
  execute 'drop table if exists api.route_versions';
  execute 'drop table if exists api.routes';
  execute 'drop table if exists api.clients';
  execute 'drop function if exists private.guard_published_route_stop()';
  execute 'drop function if exists private.guard_published_route_version()';
  execute 'drop function if exists private.route_identity(text)';
  execute 'drop policy if exists user_profiles_route_executor_read on api.user_profiles';
  execute 'revoke select on table api.user_profiles from cirne_route_executor';

  delete from api.role_permissions
  where permission_code in ('route.read_self', 'route.plan_scoped', 'route.read_scoped');

  execute 'revoke all privileges on schema api, private, extensions from cirne_route_executor granted by current_user';
  execute 'revoke cirne_route_executor from current_user granted by current_user';
  execute 'drop role cirne_route_executor';
end
$rollback$;

commit;
