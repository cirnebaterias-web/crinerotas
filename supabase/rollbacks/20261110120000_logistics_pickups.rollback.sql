-- Safe structural rollback only before logistics business records exist.
-- For populated systems use forward repair; never erase executed pickups/history.
begin;
select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cirne:database:migrate'));
set local lock_timeout='5s';
do $$ begin
  if exists(select 1 from api.logistics_pickups) or exists(select 1 from api.logistics_pickup_events)
    or exists(select 1 from api.pickup_schedules where status='completed') then
    raise exception 'Logistics history exists; use a forward repair and retain the current schema';
  end if;
end $$;
do $$ begin
  execute format('grant cirne_scrap_executor to %I with set true granted by current_user',current_user);
end $$;
drop trigger logistics_promise_immutable on api.pickup_schedules;
drop trigger logistics_original_immutable on api.logistics_pickups;
drop trigger logistics_pickups_no_delete on api.logistics_pickups;
drop trigger logistics_pickup_events_no_delete on api.logistics_pickup_events;
drop trigger logistics_pickup_events_immutable on api.logistics_pickup_events;
drop function api.list_scrap_operations();
grant create on schema api to cirne_scrap_executor;
set local role cirne_scrap_executor;
alter function api.list_scrap_operations_before_logistics() rename to list_scrap_operations;
grant execute on function api.list_scrap_operations() to authenticated;
reset role;
revoke create on schema api from cirne_scrap_executor;
drop function api.change_logistics_pickup(uuid,text,uuid,jsonb);
drop function api.list_logistics_pickups(date);
drop function api.list_logistics_operators();
drop function private.logistics_pickup_projection(uuid,boolean);
drop function private.logistics_snapshot(jsonb);
drop function private.logistics_manager(jsonb,uuid);
drop function private.logistics_operator(jsonb);
drop function private.guard_logistics_promise();
drop function private.guard_logistics_original();
drop table api.logistics_pickup_events;
drop table api.logistics_pickups;
drop policy roles_logistics_read on api.roles;
drop policy assignments_logistics_read on api.user_role_assignments;
revoke select on api.roles,api.user_role_assignments from cirne_scrap_executor;
alter table api.pickup_schedules drop constraint pickup_schedules_status_check;
alter table api.pickup_schedules add constraint pickup_schedules_status_check check(status='pending');
alter table api.pickup_schedules drop constraint pickup_schedules_retention_until_check;
alter table api.pickup_schedules add constraint pickup_schedules_retention_until_check check(retention_until is null);
delete from api.role_permissions where permission_code in ('scrap.dispatch_pickups','scrap.execute_pickups');
do $$ begin
  execute format('revoke cirne_scrap_executor from %I granted by current_user',current_user);
end $$;
notify pgrst,'reload schema';
commit;
