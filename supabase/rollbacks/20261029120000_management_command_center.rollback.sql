begin;

do $management_ownership$
begin
  execute pg_catalog.format('grant cirne_management_executor to %I with set true granted by current_user', current_user);
end
$management_ownership$;
grant create on schema api to cirne_management_executor;
set local role cirne_management_executor;

create or replace function api.get_management_day(p_service_date date, p_operational_time_zone text)
returns jsonb language plpgsql stable security definer set search_path = '' as $function$
declare
  document jsonb := private.get_management_day(p_service_date, p_operational_time_zone);
  identity_document jsonb := private.management_identity();
  enriched_routes jsonb;
begin
  select coalesce(jsonb_agg(
    route_document || jsonb_build_object('visits', coalesce((
      select jsonb_agg(jsonb_build_object(
        'visitId', visit.id,
        'routeVersionStopId', visit.route_version_stop_id,
        'client', jsonb_build_object('id', visit.client_id, 'name', visit.context_snapshot #>> '{client,name}'),
        'status', visit.status,
        'deviceStartedAt', visit.device_started_at,
        'serverStartedAt', visit.server_started_at,
        'lastKnownUpdateAt', visit.updated_at
      ) order by visit.server_started_at, visit.id)
      from (
        select candidate.id, candidate.route_version_stop_id, candidate.route_version_id,
          candidate.client_id, candidate.seller_id, candidate.context_snapshot,
          candidate.status, candidate.device_started_at, candidate.server_started_at, candidate.updated_at
        from api.visits candidate
        where candidate.route_version_id = (route_document ->> 'routeVersionId')::uuid
          and exists (select 1 from jsonb_array_elements_text(identity_document -> 'scopeIds') scope(id)
            where scope.id::uuid = candidate.seller_id)
        order by candidate.server_started_at, candidate.id limit 50
      ) visit
    ), '[]'::jsonb))
    order by route_document -> 'seller' ->> 'displayName', route_document ->> 'routeId'
  ), '[]'::jsonb)
  into enriched_routes
  from jsonb_array_elements(document -> 'routes') route_document;
  return jsonb_set(document, '{routes}', enriched_routes);
end
$function$;

reset role;
revoke create on schema api from cirne_management_executor;
do $management_ownership$
begin
  execute pg_catalog.format('revoke cirne_management_executor from %I granted by current_user', current_user);
end
$management_ownership$;

-- The projection columns and read-only executor grants are intentionally retained:
-- PostgreSQL cannot remove view columns without cascading through the v1 private
-- function. The rollback restores the caller-facing v1 document without weakening
-- RLS or exposing a new direct entrypoint.

commit;
