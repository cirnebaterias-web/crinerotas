begin;

drop function if exists api.get_field_intelligence(text, date, date, uuid, uuid, uuid, text, text, text);
drop function if exists private.get_field_intelligence(text, date, date, uuid, uuid, uuid, text, text, text);
drop function if exists private.field_intelligence_cursor(date, timestamptz, uuid);
drop view if exists api.field_intelligence_v;

do $visit_ownership$
begin
  execute pg_catalog.format('grant cirne_visit_executor to %I with set true granted by current_user', current_user);
end
$visit_ownership$;
set local role cirne_visit_executor;
revoke select on table api.visits, api.stock_snapshots, api.competitor_price_reports,
  api.competitor_prices, api.parameter_values from cirne_field_intelligence_executor;
drop policy if exists visits_field_intelligence_read on api.visits;
drop policy if exists stock_field_intelligence_read on api.stock_snapshots;
drop policy if exists price_reports_field_intelligence_read on api.competitor_price_reports;
drop policy if exists prices_field_intelligence_read on api.competitor_prices;
drop policy if exists parameters_field_intelligence_read on api.parameter_values;
reset role;
do $visit_ownership$
begin
  execute pg_catalog.format('revoke cirne_visit_executor from %I granted by current_user', current_user);
end
$visit_ownership$;

drop policy if exists action_reports_field_intelligence_read on api.visit_commercial_action_reports;
drop policy if exists actions_field_intelligence_read on api.visit_competitor_commercial_actions;
drop policy if exists scrap_reports_field_intelligence_read on api.scrap_reports;
drop policy if exists collections_field_intelligence_read on api.scrap_collections;
drop policy if exists schedules_field_intelligence_read on api.pickup_schedules;
revoke select on table api.visit_commercial_action_reports,
  api.visit_competitor_commercial_actions, api.scrap_reports,
  api.scrap_collections, api.pickup_schedules from cirne_field_intelligence_executor;

do $identity_ownership$
begin
  execute pg_catalog.format('grant cirne_identity_executor to %I with set true granted by current_user', current_user);
end
$identity_ownership$;
set local role cirne_identity_executor;
revoke execute on function private.resolve_current_identity() from cirne_field_intelligence_executor;
reset role;
do $identity_ownership$
begin
  execute pg_catalog.format('revoke cirne_identity_executor from %I granted by current_user', current_user);
end
$identity_ownership$;

do $cleanup_role$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'cirne_field_intelligence_executor') then
    execute pg_catalog.format(
      'grant cirne_field_intelligence_executor to %I with set true granted by current_user', current_user
    );
    execute 'drop owned by cirne_field_intelligence_executor';
  end if;
end
$cleanup_role$;
drop role if exists cirne_field_intelligence_executor;

commit;
