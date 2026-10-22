begin;

do $preflight$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'cirne_management_executor') then
    raise exception 'Management day expects cirne_management_executor role to be absent';
  end if;
  if to_regclass('private.sync_failure_observations') is not null
     or to_regclass('api.management_day_v') is not null then
    raise exception 'Management day objects already exist';
  end if;
end
$preflight$;

create role cirne_management_executor
  nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;

create table private.sync_failure_observations (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references api.user_profiles(id) on delete restrict,
  device_id uuid not null,
  event_id uuid not null,
  status text not null check (status in ('recoverable_error', 'action_required')),
  error_code text not null check (error_code in (
    'AUTH_REQUIRED', 'FORBIDDEN', 'VALIDATION_FAILED', 'VERSION_CONFLICT',
    'EVENT_OUT_OF_ORDER', 'IDEMPOTENCY_KEY_REUSED', 'RATE_LIMITED',
    'DEPENDENCY_UNAVAILABLE', 'INTERNAL_ERROR'
  )),
  attempt_count integer not null default 1 check (attempt_count > 0),
  occurred_at timestamptz not null,
  first_observed_at timestamptz not null default statement_timestamp(),
  last_observed_at timestamptz not null default statement_timestamp(),
  constraint sync_failure_observations_event_key unique (actor_id, device_id, event_id)
);

create index sync_failure_observations_actor_occurred_idx
  on private.sync_failure_observations (actor_id, occurred_at desc, event_id);

revoke all on table private.sync_failure_observations from public, anon, authenticated;
grant usage, create on schema api, private to cirne_management_executor;
grant select, insert, update on table private.sync_failure_observations to cirne_management_executor;

do $route_ownership$
begin
  execute pg_catalog.format('grant cirne_route_executor to %I with set true granted by current_user', current_user);
end
$route_ownership$;
set local role cirne_route_executor;
grant select on table api.clients, api.routes, api.route_versions, api.route_version_stops,
  api.route_stop_executions to cirne_management_executor;
create policy routes_management_executor_read on api.routes
  for select to cirne_management_executor using (true);
create policy clients_management_executor_read on api.clients
  for select to cirne_management_executor using (true);
create policy route_versions_management_executor_read on api.route_versions
  for select to cirne_management_executor using (true);
create policy route_version_stops_management_executor_read on api.route_version_stops
  for select to cirne_management_executor using (true);
create policy route_stop_executions_management_executor_read on api.route_stop_executions
  for select to cirne_management_executor using (true);
reset role;
do $route_ownership$
begin
  execute pg_catalog.format('revoke cirne_route_executor from %I granted by current_user', current_user);
end
$route_ownership$;

do $identity_ownership$
begin
  execute pg_catalog.format('grant cirne_identity_executor to %I with set true granted by current_user', current_user);
end
$identity_ownership$;
set local role cirne_identity_executor;
grant execute on function private.resolve_current_identity() to cirne_management_executor;
reset role;
do $identity_ownership$
begin
  execute pg_catalog.format('revoke cirne_identity_executor from %I granted by current_user', current_user);
end
$identity_ownership$;

create view api.management_day_v as
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
  greatest(route_row.updated_at, execution_row.updated_at) as last_known_update_at
from api.routes route_row
join api.route_versions version_row on version_row.route_id = route_row.id
  and version_row.status = 'published' and version_row.superseded_at is null
join api.route_version_stops stop_row on stop_row.route_version_id = version_row.id
join api.route_stop_executions execution_row on execution_row.route_version_stop_id = stop_row.id
join api.clients client on client.id = stop_row.client_id
where route_row.status in ('published', 'in_progress', 'closed');

revoke all on table api.management_day_v from public, anon, authenticated;
grant select on table api.management_day_v to cirne_management_executor;

create function private.management_identity()
returns jsonb language plpgsql stable security definer set search_path = '' as $function$
declare identity_document jsonb := private.resolve_current_identity();
begin
  if identity_document is null
     or not (identity_document -> 'roles' @> '["manager"]'::jsonb)
     or not (identity_document -> 'capabilities' @> '["route.read_scoped"]'::jsonb)
     or jsonb_array_length(identity_document -> 'scopeIds') = 0 then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;
  return identity_document;
end
$function$;

create function private.observe_sync_failure(
  p_device_id uuid,
  p_event_id uuid,
  p_error_code text,
  p_recoverable boolean,
  p_occurred_at timestamptz
)
returns void language plpgsql volatile security definer set search_path = '' as $function$
declare
  identity_document jsonb := private.resolve_current_identity();
  v_actor_id uuid;
begin
  if identity_document is null
     or not (identity_document -> 'roles' @> '["seller"]'::jsonb)
     or not (identity_document -> 'capabilities' @> '["sync.write_self"]'::jsonb) then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;
  if p_device_id is null or p_event_id is null or p_occurred_at is null
     or p_error_code not in (
       'AUTH_REQUIRED', 'FORBIDDEN', 'VALIDATION_FAILED', 'VERSION_CONFLICT',
       'EVENT_OUT_OF_ORDER', 'IDEMPOTENCY_KEY_REUSED', 'RATE_LIMITED',
       'DEPENDENCY_UNAVAILABLE', 'INTERNAL_ERROR'
     ) then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  v_actor_id := (identity_document ->> 'id')::uuid;
  insert into private.sync_failure_observations (
    actor_id, device_id, event_id, status, error_code, occurred_at
  ) values (
    v_actor_id, p_device_id, p_event_id,
    case when p_recoverable then 'recoverable_error' else 'action_required' end,
    p_error_code, p_occurred_at
  ) on conflict on constraint sync_failure_observations_event_key do update set
    status = excluded.status,
    error_code = excluded.error_code,
    attempt_count = private.sync_failure_observations.attempt_count + 1,
    last_observed_at = statement_timestamp();
end
$function$;

create function private.resolve_sync_failure(p_device_id uuid, p_event_id uuid)
returns void language plpgsql volatile security definer set search_path = '' as $function$
declare
  identity_document jsonb := private.resolve_current_identity();
  v_actor_id uuid;
begin
  if identity_document is null
     or not (identity_document -> 'roles' @> '["seller"]'::jsonb)
     or not (identity_document -> 'capabilities' @> '["sync.write_self"]'::jsonb) then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;
  if p_device_id is null or p_event_id is null then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  v_actor_id := (identity_document ->> 'id')::uuid;
  delete from private.sync_failure_observations
  where actor_id = v_actor_id and device_id = p_device_id and event_id = p_event_id
    and status = 'recoverable_error';
end
$function$;

create function private.get_management_day(p_service_date date, p_operational_time_zone text)
returns jsonb language plpgsql stable security definer set search_path = '' as $function$
declare
  identity_document jsonb := private.management_identity();
  generated_at timestamptz := statement_timestamp();
  result_document jsonb;
begin
  if p_service_date is null or p_operational_time_zone is null
     or not exists (select 1 from pg_catalog.pg_timezone_names where name = p_operational_time_zone) then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;

  with scoped_current as (
    select view_row.*
    from api.management_day_v view_row
    where view_row.service_date = p_service_date
      and exists (select 1 from jsonb_array_elements_text(identity_document -> 'scopeIds') scope_id
        where scope_id::uuid = view_row.seller_id)
  ), route_counts as (
    select route_id, route_version_id, version_number, seller_id, seller_display_name,
      count(*)::integer as planned,
      count(*) filter (where status = 'pending')::integer as pending,
      count(*) filter (where status = 'in_visit')::integer as in_visit,
      count(*) filter (where status = 'completed')::integer as completed,
      count(*) filter (where status = 'not_visited')::integer as not_visited,
      max(last_known_update_at) as route_updated_at
    from scoped_current
    group by route_id, route_version_id, version_number, seller_id, seller_display_name
  ), historical_ranked as (
    select route_row.id as route_id, stop_row.client_id, stop_row.id as route_version_stop_id,
      coalesce(stop_row.client_context_snapshot ->> 'name', client.name) as client_name,
      execution_row.status, execution_row.updated_at,
      row_number() over (
        partition by route_row.id, stop_row.client_id
        order by version_row.version_number desc, execution_row.updated_at desc, stop_row.id
      ) as rank
    from api.routes route_row
    join api.route_versions version_row on version_row.route_id = route_row.id
      and version_row.status = 'superseded'
    join api.route_version_stops stop_row on stop_row.route_version_id = version_row.id
    join api.route_stop_executions execution_row on execution_row.route_version_stop_id = stop_row.id
      and execution_row.status <> 'pending'
    join api.clients client on client.id = stop_row.client_id
    where route_row.service_date = p_service_date
      and exists (select 1 from route_counts count_row where count_row.route_id = route_row.id)
      and not exists (
        select 1 from scoped_current current_stop
        where current_stop.route_id = route_row.id and current_stop.client_id = stop_row.client_id
      )
  ), relevant_failures as (
    select failure.*
    from private.sync_failure_observations failure
    where (failure.occurred_at at time zone p_operational_time_zone)::date = p_service_date
      and exists (select 1 from route_counts count_row where count_row.seller_id = failure.actor_id)
  ), route_documents as (
    select count_row.*,
      coalesce((select jsonb_agg(jsonb_build_object(
        'routeVersionStopId', current_stop.route_version_stop_id,
        'clientId', current_stop.client_id,
        'clientName', current_stop.client_name,
        'reasonId', current_stop.non_visit_reason_id,
        'updatedAt', current_stop.last_known_update_at
      ) order by current_stop.client_name, current_stop.route_version_stop_id)
      from (
        select candidate.* from scoped_current candidate
        where candidate.route_id = count_row.route_id and candidate.status = 'not_visited'
        order by candidate.client_name, candidate.route_version_stop_id
        limit 50
      ) current_stop), '[]'::jsonb) as non_visits,
      coalesce((select jsonb_agg(jsonb_build_object(
        'routeVersionStopId', historical.route_version_stop_id,
        'clientId', historical.client_id,
        'clientName', historical.client_name,
        'status', historical.status,
        'updatedAt', historical.updated_at
      ) order by historical.updated_at desc, historical.route_version_stop_id)
      from (
        select candidate.* from historical_ranked candidate
        where candidate.route_id = count_row.route_id and candidate.rank = 1
        order by candidate.updated_at desc, candidate.route_version_stop_id
        limit 50
      ) historical), '[]'::jsonb) as historical_executions,
      coalesce((select jsonb_agg(jsonb_build_object(
        'eventId', failure.event_id,
        'status', failure.status,
        'errorCode', failure.error_code,
        'occurredAt', failure.occurred_at,
        'lastObservedAt', failure.last_observed_at
      ) order by failure.last_observed_at desc, failure.event_id)
      from (
        select candidate.* from relevant_failures candidate
        where candidate.actor_id = count_row.seller_id
        order by candidate.last_observed_at desc, candidate.event_id
        limit 100
      ) failure), '[]'::jsonb) as sync_issues,
      (select count(*)::integer from relevant_failures failure
        where failure.actor_id = count_row.seller_id and failure.status = 'recoverable_error') as sync_pending,
      (select count(*)::integer from relevant_failures failure
        where failure.actor_id = count_row.seller_id and failure.status = 'action_required') as sync_errors,
      (select min(failure.occurred_at) from relevant_failures failure
        where failure.actor_id = count_row.seller_id and failure.status = 'recoverable_error') as oldest_pending_at,
      (select max(failure.last_observed_at) from relevant_failures failure
        where failure.actor_id = count_row.seller_id) as sync_updated_at
    from route_counts count_row
  ), totals as (
    select coalesce(sum(planned), 0)::integer as planned,
      coalesce(sum(pending), 0)::integer as pending,
      coalesce(sum(in_visit), 0)::integer as in_visit,
      coalesce(sum(completed), 0)::integer as completed,
      coalesce(sum(not_visited), 0)::integer as not_visited,
      coalesce(sum(sync_pending), 0)::integer as sync_pending,
      coalesce(sum(sync_errors), 0)::integer as sync_errors,
      min(oldest_pending_at) as oldest_pending_at,
      max(sync_updated_at) as sync_updated_at,
      max(greatest(route_updated_at, coalesce(sync_updated_at, route_updated_at))) as last_known_update_at,
      count(*)::integer as route_count
    from route_documents
  )
  select jsonb_build_object(
    'schemaVersion', 1,
    'serviceDate', p_service_date,
    'generatedAt', generated_at,
    'lastKnownUpdateAt', totals.last_known_update_at,
    'availability', case when totals.route_count = 0 then 'empty' else 'available' end,
    'totals', jsonb_build_object(
      'planned', totals.planned, 'pending', totals.pending, 'inVisit', totals.in_visit,
      'completed', totals.completed, 'notVisited', totals.not_visited
    ),
    'sync', jsonb_build_object(
      'pending', totals.sync_pending, 'errors', totals.sync_errors,
      'oldestPendingAt', totals.oldest_pending_at, 'lastKnownAt', totals.sync_updated_at
    ),
    'routes', coalesce((select jsonb_agg(jsonb_build_object(
      'routeId', document.route_id,
      'routeVersionId', document.route_version_id,
      'versionNumber', document.version_number,
      'seller', jsonb_build_object('id', document.seller_id, 'displayName', document.seller_display_name),
      'counts', jsonb_build_object(
        'planned', document.planned, 'pending', document.pending, 'inVisit', document.in_visit,
        'completed', document.completed, 'notVisited', document.not_visited
      ),
      'sync', jsonb_build_object(
        'pending', document.sync_pending, 'errors', document.sync_errors,
        'oldestPendingAt', document.oldest_pending_at, 'lastKnownAt', document.sync_updated_at
      ),
      'nonVisits', document.non_visits,
      'historicalExecutions', document.historical_executions,
      'syncIssues', document.sync_issues,
      'lastKnownUpdateAt', greatest(document.route_updated_at, coalesce(document.sync_updated_at, document.route_updated_at))
    ) order by document.seller_display_name, document.seller_id, document.route_id)
    from route_documents document), '[]'::jsonb),
    'serverVisibilityNote',
      'Somente eventos recebidos pelo servidor estão incluídos; itens ainda apenas no aparelho não são visíveis.'
  ) into result_document from totals;

  return result_document;
end
$function$;

create function api.observe_sync_failure(
  p_device_id uuid,
  p_event_id uuid,
  p_error_code text,
  p_recoverable boolean,
  p_occurred_at timestamptz
)
returns void language sql volatile security definer set search_path = '' as $function$
  select private.observe_sync_failure(p_device_id, p_event_id, p_error_code, p_recoverable, p_occurred_at);
$function$;

create function api.resolve_sync_failure(p_device_id uuid, p_event_id uuid)
returns void language sql volatile security definer set search_path = '' as $function$
  select private.resolve_sync_failure(p_device_id, p_event_id);
$function$;

create function api.get_management_day(p_service_date date, p_operational_time_zone text)
returns jsonb language sql stable security definer set search_path = '' as $function$
  select private.get_management_day(p_service_date, p_operational_time_zone);
$function$;

comment on view api.management_day_v is
  'Projeção canônica da composição publicada vigente; acesso somente pelo executor gerencial.';
comment on function api.get_management_day(date, text) is
  'Consolida a execução diária para Gestor autorizado, sem payloads ou eventos exclusivamente locais.';
comment on function api.observe_sync_failure(uuid, uuid, text, boolean, timestamptz) is
  'Registra somente metadados sanitizados de falha que alcançou o servidor.';
comment on function api.resolve_sync_failure(uuid, uuid) is
  'Remove uma pendência recuperável quando o mesmo evento é confirmado pelo servidor.';

do $ownership$
begin
  execute pg_catalog.format('grant cirne_management_executor to %I with set true granted by current_user', current_user);
end
$ownership$;
alter table private.sync_failure_observations owner to cirne_management_executor;
alter view api.management_day_v owner to cirne_management_executor;
alter function private.management_identity() owner to cirne_management_executor;
alter function private.observe_sync_failure(uuid, uuid, text, boolean, timestamptz) owner to cirne_management_executor;
alter function private.resolve_sync_failure(uuid, uuid) owner to cirne_management_executor;
alter function private.get_management_day(date, text) owner to cirne_management_executor;
alter function api.observe_sync_failure(uuid, uuid, text, boolean, timestamptz) owner to cirne_management_executor;
alter function api.resolve_sync_failure(uuid, uuid) owner to cirne_management_executor;
alter function api.get_management_day(date, text) owner to cirne_management_executor;
revoke create on schema api, private from cirne_management_executor;
set local role cirne_management_executor;
revoke all on function private.management_identity() from public, anon, authenticated;
revoke all on function private.observe_sync_failure(uuid, uuid, text, boolean, timestamptz) from public, anon, authenticated;
revoke all on function private.resolve_sync_failure(uuid, uuid) from public, anon, authenticated;
revoke all on function private.get_management_day(date, text) from public, anon, authenticated;
revoke all on function api.observe_sync_failure(uuid, uuid, text, boolean, timestamptz) from public, anon;
revoke all on function api.resolve_sync_failure(uuid, uuid) from public, anon;
revoke all on function api.get_management_day(date, text) from public, anon;
grant execute on function api.observe_sync_failure(uuid, uuid, text, boolean, timestamptz) to authenticated;
grant execute on function api.resolve_sync_failure(uuid, uuid) to authenticated;
grant execute on function api.get_management_day(date, text) to authenticated;
reset role;
do $ownership$
begin
  execute pg_catalog.format('revoke cirne_management_executor from %I granted by current_user', current_user);
end
$ownership$;

commit;
