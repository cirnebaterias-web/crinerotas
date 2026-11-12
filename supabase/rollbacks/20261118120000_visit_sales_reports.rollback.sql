-- Story 4.40 rollback. Stop the application writer first. Once declarations have
-- been accepted, export/retain them and plan a forward repair instead of erasing facts.
begin;
select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cirne:database:migrate'));
set local lock_timeout = '5s';
do $preflight$
begin
  if exists (select 1 from api.visit_sales_reports)
    or exists (select 1 from private.sync_events where operation = 'visit.sales.saved.v1') then
    raise exception 'VISIT_SALES_ROLLBACK_REQUIRES_EMPTY_HISTORY';
  end if;
end
$preflight$;
do $membership$
declare executor text;
begin
  foreach executor in array array['cirne_visit_sales_executor','cirne_visit_executor',
    'cirne_sync_executor','cirne_identity_executor','cirne_scrap_executor','cirne_visit_detail_executor','cirne_route_executor'] loop
    execute pg_catalog.format('grant %I to %I with set true granted by current_user',executor,current_user);
  end loop;
end
$membership$;
grant create on schema private to cirne_scrap_executor, cirne_visit_detail_executor;

set local role cirne_visit_executor;
drop policy observed_locations_checkout_executor_read on api.client_observed_locations;
drop policy observed_locations_checkout_executor_insert on api.client_observed_locations;
drop policy observed_locations_checkout_executor_update on api.client_observed_locations;
drop trigger require_visit_sales_before_completion on api.visits;
drop function private.lock_visit_for_sales(uuid,uuid);
drop policy visits_sales_executor_read on api.visits;
revoke select on api.visits from cirne_visit_sales_executor;
reset role;
set local role cirne_route_executor;
drop policy clients_checkout_executor_read on api.clients;
revoke select (id,location) on api.clients from cirne_visit_executor;
reset role;
set local role cirne_visit_detail_executor;
drop function private.get_visit_detail(uuid,uuid,text);
alter function private.get_visit_detail_before_sales(uuid,uuid,text) rename to get_visit_detail;
reset role;
set local role cirne_visit_sales_executor;
drop function api.save_visit_sales(uuid,uuid,jsonb);
drop function api.get_visit_sales(uuid,uuid);
drop function private.sync_event(uuid,jsonb);
drop function private.require_sales_before_completion();
drop function private.visit_sales_identity();
drop table api.visit_sales_reports;
reset role;
set local role cirne_scrap_executor;
revoke execute on function private.sync_event_before_sales(uuid,jsonb) from cirne_visit_sales_executor;
alter function private.sync_event_before_sales(uuid,jsonb) rename to sync_event;
reset role;
set local role cirne_sync_executor;
alter table private.sync_events drop constraint sync_events_operation_check;
alter table private.sync_events add constraint sync_events_operation_check check (operation in (
  'visit.draft.saved','visit.started.v1','visit.stock.saved.v1','visit.prices.saved.v1',
  'visit.commercial-actions.saved.v1','visit.scrap.saved.v1'
));
revoke select, insert on private.sync_events from cirne_visit_sales_executor;
revoke insert on private.audit_events from cirne_visit_sales_executor;
reset role;
set local role cirne_identity_executor;
revoke execute on function private.resolve_current_identity() from cirne_visit_sales_executor;
reset role;
drop policy action_reports_sales_executor_read on api.visit_commercial_action_reports;
revoke select on api.visit_commercial_action_reports from cirne_visit_sales_executor;
revoke usage on schema api, private, extensions from cirne_visit_sales_executor;
revoke create on schema private from cirne_scrap_executor, cirne_visit_detail_executor;
do $membership$
declare executor text;
begin
  foreach executor in array array['cirne_visit_sales_executor','cirne_visit_executor',
    'cirne_sync_executor','cirne_identity_executor','cirne_scrap_executor','cirne_visit_detail_executor','cirne_route_executor'] loop
    execute pg_catalog.format('revoke %I from %I granted by current_user',executor,current_user);
  end loop;
end
$membership$;
drop role cirne_visit_sales_executor;
commit;
