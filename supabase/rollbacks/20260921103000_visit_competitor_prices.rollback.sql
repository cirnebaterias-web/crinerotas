-- Safe rollback for Story 3.3. Refuses to erase visit facts or configured values.
begin;
select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cirne:database:migrate'));
set local lock_timeout = '5s';

create temp table visit_competitor_prices_rollback_memberships (
  visit_membership_existed boolean not null,
  visit_set_option boolean,
  sync_membership_existed boolean not null,
  sync_set_option boolean
) on commit drop;
insert into visit_competitor_prices_rollback_memberships
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

do $safety$
begin
  if to_regclass('api.competitor_price_reports') is null
     or to_regprocedure('private.sync_event_before_prices(uuid,jsonb)') is null then
    raise exception 'Visit competitor prices capability is not fully installed';
  end if;
  if exists (select 1 from api.competitor_price_reports)
     or exists (select 1 from api.competitor_prices)
     or exists (select 1 from api.parameter_values)
     or exists (select 1 from private.sync_events where operation = 'visit.prices.saved.v1') then
    raise exception 'Rollback refused: competitor-price history or parameter values exist';
  end if;
end
$safety$;

do $rollback_ownership$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'cirne_visit_executor')
     or not exists (select 1 from pg_catalog.pg_roles where rolname = 'cirne_sync_executor') then
    raise exception 'Visit competitor prices rollback expects executor roles to exist';
  end if;
  execute pg_catalog.format('grant cirne_visit_executor to %I with set true granted by current_user', current_user);
  execute pg_catalog.format('grant cirne_sync_executor to %I with set true granted by current_user', current_user);
end
$rollback_ownership$;

grant create on schema private to cirne_visit_executor;
set local role cirne_visit_executor;
do $restore_visit_start_catalog_resolution$
declare
  v_definition text := pg_catalog.pg_get_functiondef('private.apply_visit_started(uuid,jsonb)'::regprocedure);
  v_historical_predicate constant text := 'where parameter_row.status in (''published'', ''retired'')';
  v_previous_predicate constant text := 'where parameter_row.status = ''published''';
begin
  if pg_catalog.strpos(v_definition, v_historical_predicate) = 0 then
    raise exception 'Visit start catalog predicate does not match the Story 3.3 definition';
  end if;
  execute pg_catalog.replace(v_definition, v_historical_predicate, v_previous_predicate);
end
$restore_visit_start_catalog_resolution$;
reset role;
revoke create on schema private from cirne_visit_executor;

set local role cirne_visit_executor;
drop function api.save_visit_competitor_prices(uuid, uuid, jsonb);
drop function api.get_current_competitor_price_parameters(timestamptz);
reset role;

grant create on schema private to cirne_sync_executor;
set local role cirne_sync_executor;
drop function private.save_visit_competitor_prices(uuid, uuid, jsonb);
drop function private.sync_event(uuid, jsonb);
alter function private.sync_event_before_prices(uuid, jsonb) rename to sync_event;
alter table private.sync_events drop constraint sync_events_operation_check;
alter table private.sync_events add constraint sync_events_operation_check
  check (operation in ('visit.draft.saved', 'visit.started.v1', 'visit.stock.saved.v1'));
reset role;
revoke create on schema private from cirne_sync_executor;

set local role cirne_visit_executor;
drop function private.apply_visit_competitor_prices_saved(uuid, jsonb);
drop function private.get_visit_competitor_prices_result(uuid);
drop table private.competitor_price_receipts;
drop table api.competitor_prices;
drop table api.competitor_price_reports;
drop table api.parameter_values;
drop function private.guard_published_parameter_values();
reset role;

do $rollback_ownership$
declare
  membership visit_competitor_prices_rollback_memberships%rowtype;
begin
  select * into strict membership from visit_competitor_prices_rollback_memberships;
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
