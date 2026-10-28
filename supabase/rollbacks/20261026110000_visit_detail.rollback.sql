begin;

drop function if exists api.authorize_visit_attachment_download(uuid, uuid, text);
drop function if exists private.authorize_visit_attachment_download(uuid, uuid, text);
drop function if exists api.get_visit_detail(uuid, uuid, text);
drop function if exists private.get_visit_detail(uuid, uuid, text);
drop policy if exists scrap_evidence_manager_sensitive_read on storage.objects;
drop policy if exists visit_evidence_manager_sensitive_read on storage.objects;
drop function if exists private.can_manager_download_visit_evidence(text, text);
drop function if exists private.visit_detail_identity(uuid);
drop view if exists api.visit_details_v;

do $management_function_ownership$
begin
  execute pg_catalog.format('grant cirne_management_executor to %I with set true granted by current_user', current_user);
end
$management_function_ownership$;
grant create on schema api to cirne_management_executor;
set local role cirne_management_executor;
create or replace function api.get_management_day(p_service_date date, p_operational_time_zone text)
returns jsonb language sql stable security definer set search_path = '' as $function$
  select private.get_management_day(p_service_date, p_operational_time_zone);
$function$;
reset role;
revoke create on schema api from cirne_management_executor;
do $management_function_ownership$
begin
  execute pg_catalog.format('revoke cirne_management_executor from %I granted by current_user', current_user);
end
$management_function_ownership$;

revoke select on table api.visits from cirne_management_executor;
drop policy if exists visits_management_executor_read on api.visits;
drop policy if exists storage_visit_detail_executor_read on storage.objects;
drop policy if exists audit_events_detail_executor_insert on private.audit_events;
drop policy if exists audit_events_detail_executor_read on private.audit_events;
drop policy if exists sync_failures_detail_executor_read on private.sync_failure_observations;
drop policy if exists sync_events_detail_executor_read on private.sync_events;
drop policy if exists location_events_detail_executor_read on api.location_events;
drop policy if exists scrap_attachments_detail_executor_read on api.scrap_attachments;
drop policy if exists visit_attachments_detail_executor_read on api.visit_attachments;
drop policy if exists pickup_schedules_detail_executor_read on api.pickup_schedules;
drop policy if exists scrap_collections_detail_executor_read on api.scrap_collections;
drop policy if exists scrap_reports_detail_executor_read on api.scrap_reports;
drop policy if exists competitor_actions_detail_executor_read on api.visit_competitor_commercial_actions;
drop policy if exists own_actions_detail_executor_read on api.visit_own_action_acknowledgements;
drop policy if exists action_reports_detail_executor_read on api.visit_commercial_action_reports;
drop policy if exists parameter_values_detail_executor_read on api.parameter_values;
drop policy if exists prices_detail_executor_read on api.competitor_prices;
drop policy if exists price_reports_detail_executor_read on api.competitor_price_reports;
drop policy if exists stock_detail_executor_read on api.stock_snapshots;
drop policy if exists visits_detail_executor_read on api.visits;

set local role postgres;
revoke usage on schema storage from cirne_visit_detail_executor;
revoke select on table storage.objects from cirne_visit_detail_executor;
reset role;
drop owned by cirne_visit_detail_executor;
drop role if exists cirne_visit_detail_executor;

commit;
