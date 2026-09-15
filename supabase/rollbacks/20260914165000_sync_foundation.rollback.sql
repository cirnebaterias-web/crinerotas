begin;

do $rollback$
declare
  foundation_owned boolean;
  foundation_footprint boolean;
  identity_current_grant_exists boolean;
  identity_current_set_option boolean;
  identity_effective_set_option boolean;
  sync_role_id oid;
  unexpected_dependencies boolean;
begin
  foundation_footprint :=
    pg_catalog.to_regprocedure('api.sync_event(uuid,jsonb)') is not null
    or pg_catalog.to_regprocedure('private.sync_event(uuid,jsonb)') is not null
    or pg_catalog.to_regclass('private.sync_events') is not null
    or pg_catalog.to_regclass('private.audit_events') is not null
    or exists (select 1 from api.role_permissions where permission_code = 'sync.write_self');

  if not foundation_footprint then
    return;
  end if;

  foundation_owned :=
    exists (
      select 1
      from pg_catalog.pg_proc procedure
      join pg_catalog.pg_roles owner_role on owner_role.oid = procedure.proowner
      where procedure.oid = pg_catalog.to_regprocedure('api.sync_event(uuid,jsonb)')
        and owner_role.rolname = 'cirne_sync_executor'
    )
    and exists (
      select 1
      from pg_catalog.pg_proc procedure
      join pg_catalog.pg_roles owner_role on owner_role.oid = procedure.proowner
      where procedure.oid = pg_catalog.to_regprocedure('private.sync_event(uuid,jsonb)')
        and owner_role.rolname = 'cirne_sync_executor'
    )
    and exists (
      select 1
      from pg_catalog.pg_class relation
      join pg_catalog.pg_roles owner_role on owner_role.oid = relation.relowner
      where relation.oid = pg_catalog.to_regclass('private.sync_events')
        and owner_role.rolname = 'cirne_sync_executor'
    )
    and exists (
      select 1
      from pg_catalog.pg_class relation
      join pg_catalog.pg_roles owner_role on owner_role.oid = relation.relowner
      where relation.oid = pg_catalog.to_regclass('private.audit_events')
        and owner_role.rolname = 'cirne_sync_executor'
    );

  if not foundation_owned then
    raise exception 'Cannot roll back sync foundation with incomplete objects or unexpected owners';
  end if;

  select oid into sync_role_id from pg_catalog.pg_roles where rolname = 'cirne_sync_executor';
  select exists (
    select 1
    from pg_catalog.pg_shdepend dependency
    where dependency.refclassid = 'pg_authid'::regclass
      and dependency.refobjid = sync_role_id
      and (dependency.dbid = 0 or dependency.dbid = (
        select oid from pg_catalog.pg_database where datname = current_database()
      ))
      and not (
        (dependency.deptype = 'o' and dependency.classid = 'pg_class'::regclass and dependency.objid in (
          pg_catalog.to_regclass('private.sync_events'),
          pg_catalog.to_regclass('private.audit_events')
        ))
        or (dependency.deptype = 'o' and dependency.classid = 'pg_proc'::regclass and dependency.objid in (
          pg_catalog.to_regprocedure('api.sync_event(uuid,jsonb)'),
          pg_catalog.to_regprocedure('private.sync_event(uuid,jsonb)')
        ))
        or (dependency.deptype = 'a' and dependency.classid = 'pg_namespace'::regclass and dependency.objid in (
          pg_catalog.to_regnamespace('api'),
          pg_catalog.to_regnamespace('private'),
          pg_catalog.to_regnamespace('extensions')
        ))
        or (dependency.deptype = 'a' and dependency.classid = 'pg_proc'::regclass
          and dependency.objid = pg_catalog.to_regprocedure('private.resolve_current_identity()'))
      )
  ) into unexpected_dependencies;
  if unexpected_dependencies then
    raise exception 'Cannot roll back sync foundation while its role has unexpected dependencies';
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

  execute pg_catalog.format('grant cirne_sync_executor to %I with set true granted by current_user', current_user);
  if not identity_effective_set_option then
    execute pg_catalog.format('grant cirne_identity_executor to %I with set true granted by current_user', current_user);
  end if;
  execute 'set local role cirne_identity_executor';
  execute 'revoke execute on function private.resolve_current_identity() from cirne_sync_executor';
  execute 'reset role';

  execute 'drop function api.sync_event(uuid, jsonb)';
  execute 'drop function private.sync_event(uuid, jsonb)';
  execute 'drop table private.audit_events';
  execute 'drop table private.sync_events';
  delete from api.role_permissions where permission_code = 'sync.write_self';

  execute 'revoke all privileges on schema api, private, extensions from cirne_sync_executor granted by current_user';
  execute 'drop role cirne_sync_executor';
  if not identity_effective_set_option and coalesce(identity_current_grant_exists, false) then
    execute pg_catalog.format(
      'grant cirne_identity_executor to %I with set %s granted by current_user',
      current_user,
      case when identity_current_set_option then 'true' else 'false' end
    );
  elsif not identity_effective_set_option then
    execute pg_catalog.format('revoke cirne_identity_executor from %I granted by current_user', current_user);
  end if;
end
$rollback$;

commit;
