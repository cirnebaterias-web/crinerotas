begin;
set local lock_timeout = '5s';

create temp table visit_stock_rollback_memberships (
  visit_membership_existed boolean not null,
  visit_set_option boolean,
  sync_membership_existed boolean not null,
  sync_set_option boolean
) on commit drop;
insert into visit_stock_rollback_memberships
select
  visit_membership.roleid is not null,
  visit_membership.set_option,
  sync_membership.roleid is not null,
  sync_membership.set_option
from (select oid from pg_catalog.pg_roles where rolname = current_user) actor
left join pg_catalog.pg_auth_members visit_membership
  on visit_membership.member = actor.oid
  and visit_membership.roleid = (select oid from pg_catalog.pg_roles where rolname = 'cirne_visit_executor')
  and visit_membership.grantor = actor.oid
left join pg_catalog.pg_auth_members sync_membership
  on sync_membership.member = actor.oid
  and sync_membership.roleid = (select oid from pg_catalog.pg_roles where rolname = 'cirne_sync_executor')
  and sync_membership.grantor = actor.oid;

do $rollback_ownership$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'cirne_visit_executor')
     or not exists (select 1 from pg_catalog.pg_roles where rolname = 'cirne_sync_executor')
     or to_regclass('api.stock_snapshots') is null
     or to_regprocedure('api.save_visit_stock(uuid,uuid,jsonb)') is null then
    raise exception 'Visit stock rollback expects the capability to be installed';
  end if;
  execute pg_catalog.format('grant cirne_visit_executor to %I with set true granted by current_user', current_user);
  execute pg_catalog.format('grant cirne_sync_executor to %I with set true granted by current_user', current_user);
end
$rollback_ownership$;

set local role cirne_visit_executor;
lock table api.stock_snapshots in access exclusive mode;
do $preflight$
begin
  if exists (select 1 from api.stock_snapshots) then
    raise exception 'Rollback refused: stock snapshots exist';
  end if;
end
$preflight$;
reset role;

set local role cirne_sync_executor;
lock table private.sync_events in access exclusive mode;
do $preflight$
begin
  if exists (select 1 from private.sync_events where operation = 'visit.stock.saved.v1') then
    raise exception 'Rollback refused: visit stock sync history exists';
  end if;
end
$preflight$;
reset role;

set local role cirne_visit_executor;
drop function api.save_visit_stock(uuid, uuid, jsonb);
reset role;
grant create on schema private to cirne_sync_executor;
set local role cirne_sync_executor;
drop function private.save_visit_stock(uuid, uuid, jsonb);
drop function private.sync_event(uuid, jsonb);
alter function private.sync_event_before_stock(uuid, jsonb) rename to sync_event;
alter table private.sync_events drop constraint sync_events_operation_check;
alter table private.sync_events add constraint sync_events_operation_check
  check (operation in ('visit.draft.saved', 'visit.started.v1'));
reset role;
revoke create on schema private from cirne_sync_executor;
set local role cirne_visit_executor;
drop function private.apply_visit_stock_saved(uuid, jsonb);
drop function private.get_visit_stock_result(uuid);
drop table api.stock_snapshots;
reset role;

do $rollback_ownership$
declare
  membership visit_stock_rollback_memberships%rowtype;
begin
  select * into strict membership from visit_stock_rollback_memberships;
  if not membership.visit_membership_existed then
    execute pg_catalog.format('revoke cirne_visit_executor from %I granted by current_user', current_user);
  elsif not membership.visit_set_option then
    execute pg_catalog.format('grant cirne_visit_executor to %I with set false granted by current_user', current_user);
  end if;
  if not membership.sync_membership_existed then
    execute pg_catalog.format('revoke cirne_sync_executor from %I granted by current_user', current_user);
  elsif not membership.sync_set_option then
    execute pg_catalog.format('grant cirne_sync_executor to %I with set false granted by current_user', current_user);
  end if;
end
$rollback_ownership$;

commit;
