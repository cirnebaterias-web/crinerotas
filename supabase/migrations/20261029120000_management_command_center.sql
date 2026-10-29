begin;

-- The command-center reader only needs presence/state metadata. Direct table access
-- remains unavailable to authenticated callers; the scoped RPC is the sole entrypoint.
grant select on table api.visit_commercial_action_reports, api.scrap_reports
to cirne_management_executor;

do $visit_ownership$
begin
  execute pg_catalog.format('grant cirne_visit_executor to %I with set true granted by current_user', current_user);
end
$visit_ownership$;
set local role cirne_visit_executor;
grant select on table api.visit_attachments, api.location_events, api.stock_snapshots,
  api.competitor_price_reports, api.parameter_values
to cirne_management_executor;
drop policy if exists visit_attachments_management_executor_read on api.visit_attachments;
drop policy if exists location_events_management_executor_read on api.location_events;
drop policy if exists stock_snapshots_management_executor_read on api.stock_snapshots;
drop policy if exists competitor_price_reports_management_executor_read on api.competitor_price_reports;
drop policy if exists parameter_values_management_executor_read on api.parameter_values;
create policy visit_attachments_management_executor_read on api.visit_attachments
  for select to cirne_management_executor using (true);
create policy location_events_management_executor_read on api.location_events
  for select to cirne_management_executor using (true);
create policy stock_snapshots_management_executor_read on api.stock_snapshots
  for select to cirne_management_executor using (true);
create policy competitor_price_reports_management_executor_read on api.competitor_price_reports
  for select to cirne_management_executor using (true);
create policy parameter_values_management_executor_read on api.parameter_values
  for select to cirne_management_executor using (true);
reset role;
do $visit_ownership$
begin
  execute pg_catalog.format('revoke cirne_visit_executor from %I granted by current_user', current_user);
end
$visit_ownership$;
drop policy if exists commercial_action_reports_management_executor_read on api.visit_commercial_action_reports;
drop policy if exists scrap_reports_management_executor_read on api.scrap_reports;
create policy commercial_action_reports_management_executor_read on api.visit_commercial_action_reports
  for select to cirne_management_executor using (true);
create policy scrap_reports_management_executor_read on api.scrap_reports
  for select to cirne_management_executor using (true);

do $management_ownership$
begin
  execute pg_catalog.format('grant cirne_management_executor to %I with set true granted by current_user', current_user);
end
$management_ownership$;

grant create on schema api to cirne_management_executor;
set local role cirne_management_executor;

create or replace view api.management_day_v as
select
  route_row.id as route_id,
  route_row.service_date,
  route_row.seller_id,
  version_row.seller_context_snapshot ->> 'displayName' as seller_display_name,
  version_row.id as route_version_id,
  version_row.version_number,
  stop_row.id as route_version_stop_id,
  stop_row.client_id,
  coalesce(stop_row.client_context_snapshot ->> 'name', client.name) as client_name,
  execution_row.status,
  execution_row.non_visit_reason_id,
  greatest(route_row.updated_at, execution_row.updated_at) as last_known_update_at,
  stop_row.planned_order,
  execution_row.execution_order,
  stop_row.priority,
  coalesce(reason.label, 'Motivo registrado') as non_visit_reason_label
from api.routes route_row
join api.route_versions version_row on version_row.route_id = route_row.id
  and version_row.status = 'published' and version_row.superseded_at is null
join api.route_version_stops stop_row on stop_row.route_version_id = version_row.id
join api.route_stop_executions execution_row on execution_row.route_version_stop_id = stop_row.id
join api.clients client on client.id = stop_row.client_id
left join api.parameter_values reason on reason.id = execution_row.non_visit_reason_id
where route_row.status in ('published', 'in_progress', 'closed');

create or replace function api.get_management_day(p_service_date date, p_operational_time_zone text)
returns jsonb language plpgsql stable security definer set search_path = '' as $function$
declare
  base_document jsonb := private.get_management_day(p_service_date, p_operational_time_zone);
  identity_document jsonb := private.management_identity();
  enriched_routes jsonb;
begin
  with route_documents as (
    select route_document
    from jsonb_array_elements(base_document -> 'routes') route_document
  ), scoped_stops as (
    select day_row.service_date, day_row.seller_id, day_row.route_version_id,
      day_row.route_version_stop_id, day_row.client_id, day_row.client_name,
      day_row.status, day_row.non_visit_reason_id, day_row.non_visit_reason_label,
      day_row.last_known_update_at, day_row.planned_order, day_row.execution_order, day_row.priority
    from api.management_day_v day_row
    where day_row.service_date = p_service_date
      and exists (
        select 1 from jsonb_array_elements_text(identity_document -> 'scopeIds') scope(id)
        where scope.id::uuid = day_row.seller_id
      )
  ), scoped_visits as (
    select visit.id, visit.route_version_stop_id, visit.route_version_id, visit.client_id,
      visit.context_snapshot, visit.status, visit.device_started_at, visit.server_started_at, visit.updated_at,
      row_number() over (partition by visit.route_version_id
        order by visit.server_started_at desc, visit.id desc) as route_rank,
      row_number() over (partition by visit.route_version_stop_id
        order by visit.server_started_at desc, visit.id desc) as stop_rank
    from api.visits visit
    where exists (select 1 from scoped_stops stop where stop.route_version_stop_id = visit.route_version_stop_id)
  ), visit_documents as (
    select visit.route_version_stop_id, visit.route_version_id, visit.server_started_at, visit.id,
      visit.route_rank, visit.stop_rank,
      jsonb_build_object(
        'visitId', visit.id,
        'routeVersionStopId', visit.route_version_stop_id,
        'client', jsonb_build_object(
          'id', visit.client_id,
          'name', coalesce(visit.context_snapshot #>> '{client,name}', 'Cliente sem nome')
        ),
        'status', visit.status,
        'deviceStartedAt', visit.device_started_at,
        'serverStartedAt', visit.server_started_at,
        'lastKnownUpdateAt', visit.updated_at,
        'exceptionCount', least(20, coalesce((
          select sum(cardinality(location.issues))::integer
          from api.location_events location where location.visit_id = visit.id
        ), 0)),
        'checklist', jsonb_build_object(
          'facadeCheckin', case
            when exists (select 1 from api.visit_attachments attachment
              where attachment.visit_id = visit.id and attachment.purpose = 'visit_checkin' and attachment.status = 'verified') then 'confirmed'
            when exists (select 1 from api.location_events location
              where location.visit_id = visit.id and location.kind = 'start' and 'camera_unavailable' = any(location.issues)) then 'exception'
            else 'unknown_to_server' end,
          'checkout', case
            when exists (select 1 from api.visit_attachments attachment
              where attachment.visit_id = visit.id and attachment.purpose = 'visit_checkout' and attachment.status = 'verified') then 'confirmed'
            when exists (select 1 from api.location_events location
              where location.visit_id = visit.id and location.kind = 'completion' and 'camera_unavailable' = any(location.issues)) then 'exception'
            when visit.status = 'completed' then 'action_required'
            else 'not_occurred' end,
          'stock', case
            when exists (select 1 from api.stock_snapshots item where item.visit_id = visit.id) then 'confirmed'
            when visit.status = 'completed' then 'action_required' else 'unknown_to_server' end,
          'competitorPrices', case
            when exists (select 1 from api.competitor_price_reports item where item.visit_id = visit.id) then 'confirmed'
            when visit.status = 'completed' then 'action_required' else 'unknown_to_server' end,
          'commercialActions', case
            when exists (select 1 from api.visit_commercial_action_reports item where item.visit_id = visit.id) then 'confirmed'
            when visit.status = 'completed' then 'action_required' else 'unknown_to_server' end,
          'scrap', case
            when exists (select 1 from api.scrap_reports item where item.visit_id = visit.id) then 'confirmed'
            when visit.status = 'completed' then 'action_required' else 'unknown_to_server' end,
          'result', case when visit.status = 'completed' then 'confirmed' else 'not_occurred' end,
          'synchronization', 'confirmed'
        )
      ) as document
    from scoped_visits visit
  ), stop_documents as (
    select stop.route_version_id, stop.execution_order, stop.route_version_stop_id,
      jsonb_build_object(
        'routeVersionStopId', stop.route_version_stop_id,
        'plannedOrder', stop.planned_order,
        'executionOrder', stop.execution_order,
        'priority', stop.priority,
        'client', jsonb_build_object('id', stop.client_id, 'name', stop.client_name),
        'status', stop.status,
        'nonVisitReason', case when stop.non_visit_reason_id is null then null else jsonb_build_object(
          'id', stop.non_visit_reason_id, 'label', stop.non_visit_reason_label
        ) end,
        'lastKnownUpdateAt', greatest(stop.last_known_update_at, coalesce((
          select max(visit.updated_at) from scoped_visits visit
          where visit.route_version_stop_id = stop.route_version_stop_id
        ), stop.last_known_update_at)),
        'visits', coalesce((select jsonb_agg(visit.document order by visit.server_started_at, visit.id)
          from visit_documents visit where visit.route_version_stop_id = stop.route_version_stop_id
            and visit.stop_rank <= 10), '[]'::jsonb)
      ) as document
    from scoped_stops stop
  )
  select coalesce(jsonb_agg(
    route.route_document || jsonb_build_object(
      'visits', coalesce((select jsonb_agg(
        visit.document - 'checklist' - 'exceptionCount' order by visit.server_started_at, visit.id
      ) from visit_documents visit
        where visit.route_version_id = (route.route_document ->> 'routeVersionId')::uuid
          and visit.route_rank <= 50), '[]'::jsonb),
      'stops', coalesce((select jsonb_agg(stop.document order by stop.execution_order, stop.route_version_stop_id)
        from stop_documents stop
        where stop.route_version_id = (route.route_document ->> 'routeVersionId')::uuid), '[]'::jsonb)
    ) order by route.route_document -> 'seller' ->> 'displayName', route.route_document ->> 'routeId'
  ), '[]'::jsonb)
  into enriched_routes
  from route_documents route;

  return jsonb_set(jsonb_set(base_document, '{schemaVersion}', '2'::jsonb), '{routes}', enriched_routes);
end
$function$;

comment on function api.get_management_day(date, text) is
  'Consolida a central operacional v2 em uma leitura autorizada; expõe somente presença e estado sanitizados.';

reset role;
revoke create on schema api from cirne_management_executor;

do $management_ownership$
begin
  execute pg_catalog.format('revoke cirne_management_executor from %I granted by current_user', current_user);
end
$management_ownership$;

commit;
