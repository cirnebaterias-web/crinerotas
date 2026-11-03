begin;

do $membership$
begin
  execute pg_catalog.format('grant cirne_administration_executor to %I with set true granted by current_user', current_user);
  execute pg_catalog.format('grant cirne_identity_executor to %I with set true granted by current_user', current_user);
  execute pg_catalog.format('grant cirne_visit_executor to %I with set true granted by current_user', current_user);
  execute pg_catalog.format('grant cirne_sync_executor to %I with set true granted by current_user', current_user);
end
$membership$;

set local role cirne_identity_executor;
revoke execute on function private.resolve_current_identity() from cirne_administration_executor;
reset role;

set local role cirne_administration_executor;
drop function if exists api.update_administration_user(uuid,jsonb,text);
drop function if exists api.get_administration_snapshot();
drop function if exists private.administration_command_valid(jsonb);
drop function if exists private.administration_user_document(uuid);
drop function if exists private.administration_identity();
drop table if exists private.administration_commands;
reset role;

set local role cirne_sync_executor;
drop policy if exists audit_events_administration_executor_insert on private.audit_events;
drop policy if exists audit_events_administration_executor_read on private.audit_events;
reset role;
set local role cirne_visit_executor;
drop policy if exists parameter_values_administration_executor_read on api.parameter_values;
drop policy if exists parameter_sets_administration_executor_read on api.parameter_sets;
reset role;
drop policy if exists user_seller_scopes_administration_executor_all on api.user_seller_scopes;
drop policy if exists user_role_assignments_administration_executor_all on api.user_role_assignments;
drop policy if exists role_permissions_administration_executor_read on api.role_permissions;
drop policy if exists roles_administration_executor_read on api.roles;
drop policy if exists user_profiles_administration_executor_all on api.user_profiles;

revoke select, update, references on api.user_profiles from cirne_administration_executor;
revoke select on api.roles, api.role_permissions, api.parameter_sets, api.parameter_values
  from cirne_administration_executor;
revoke select, insert, update on api.user_role_assignments, api.user_seller_scopes
  from cirne_administration_executor;
revoke select, insert on private.audit_events from cirne_administration_executor;
revoke all on schema api, private, extensions from cirne_administration_executor;
revoke cirne_administration_executor from current_user granted by current_user;
revoke cirne_identity_executor from current_user granted by current_user;
revoke cirne_visit_executor from current_user granted by current_user;
revoke cirne_sync_executor from current_user granted by current_user;
drop role cirne_administration_executor;

commit;
