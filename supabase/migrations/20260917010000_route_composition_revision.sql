begin;

do $preflight$
begin
  if to_regclass('api.route_versions') is null
     or to_regprocedure('api.publish_route(uuid,integer)') is null then
    raise exception 'Route composition revision requires route foundation';
  end if;
  if to_regprocedure('api.change_route_composition(uuid,jsonb,uuid,text)') is not null then
    raise exception 'Route composition revision already exists';
  end if;
end
$preflight$;

do $audit_ownership$
begin
  execute pg_catalog.format('grant cirne_sync_executor to %I with set true granted by current_user', current_user);
end
$audit_ownership$;
grant create on schema private to cirne_sync_executor;
set local role cirne_sync_executor;
create unique index audit_events_route_composition_idempotency_key
  on private.audit_events (actor_id, action, request_id)
  where action = 'route.composition.drafted' and request_id is not null;
grant select on table private.audit_events to cirne_route_executor;
reset role;
revoke create on schema private from cirne_sync_executor;
do $audit_ownership$
begin
  execute pg_catalog.format('revoke cirne_sync_executor from %I granted by current_user', current_user);
end
$audit_ownership$;

do $ownership$
begin
  execute pg_catalog.format('grant cirne_route_executor to %I with set true granted by current_user', current_user);
end
$ownership$;
grant create on schema api, private to cirne_route_executor;
set local role cirne_route_executor;

alter table api.route_versions
  add column if not exists change_reason text,
  add column if not exists change_summary jsonb;

create function private.change_route_composition(
  p_route_id uuid,
  p_command jsonb,
  p_idempotency_key uuid,
  p_origin text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  identity_document jsonb := private.route_identity('route.plan_scoped');
  v_actor_id uuid := (identity_document ->> 'id')::uuid;
  route_row api.routes%rowtype;
  published_row api.route_versions%rowtype;
  draft_row api.route_versions%rowtype;
  expected_version integer;
  normalized_reason text;
  stops jsonb;
  normalized_command jsonb;
  stop_count integer;
  current_client_ids uuid[];
  requested_client_ids uuid[];
  added_ids uuid[];
  removed_ids uuid[];
  retained_ids uuid[];
  v_change_summary jsonb;
  result_document jsonb;
  stored_audit private.audit_events%rowtype;
begin
  if p_route_id is null or p_idempotency_key is null or p_origin not in ('web', 'cli')
     or p_command is null or jsonb_typeof(p_command) <> 'object'
     or not (p_command ?& array['schemaVersion', 'expectedVersion', 'reason', 'stops'])
     or (select count(*) from jsonb_object_keys(p_command)) <> 4
     or p_command -> 'schemaVersion' <> '1'::jsonb
     or jsonb_typeof(p_command -> 'expectedVersion') <> 'number'
     or jsonb_typeof(p_command -> 'reason') <> 'string'
     or jsonb_typeof(p_command -> 'stops') <> 'array' then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;

  begin
    expected_version := (p_command ->> 'expectedVersion')::integer;
  exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end;
  normalized_reason := regexp_replace(btrim(p_command ->> 'reason'), '\s+', ' ', 'g');
  stops := p_command -> 'stops';
  stop_count := jsonb_array_length(stops);
  if expected_version < 1 or char_length(normalized_reason) not between 1 and 500
     or stop_count < 1 or stop_count > 50
     or exists (
       select 1 from jsonb_array_elements(stops) stop
       where jsonb_typeof(stop) <> 'object'
          or not (stop ?& array['clientId', 'plannedOrder', 'priority'])
          or (select count(*) from jsonb_object_keys(stop)) <> 3
          or jsonb_typeof(stop -> 'clientId') <> 'string'
          or jsonb_typeof(stop -> 'plannedOrder') <> 'number'
          or jsonb_typeof(stop -> 'priority') <> 'number'
          or stop ->> 'plannedOrder' !~ '^[0-9]+$'
          or stop ->> 'priority' !~ '^[0-9]+$'
          or (stop ->> 'plannedOrder')::integer not between 1 and 50
          or (stop ->> 'priority')::integer not between 0 and 9
     ) then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;

  begin
    select array_agg((stop ->> 'clientId')::uuid order by (stop ->> 'clientId')::uuid)
    into requested_client_ids from jsonb_array_elements(stops) stop;
    if cardinality(requested_client_ids) <> (
      select count(distinct (stop ->> 'clientId')::uuid) from jsonb_array_elements(stops) stop
    ) or stop_count <> (
      select count(distinct (stop ->> 'plannedOrder')::integer) from jsonb_array_elements(stops) stop
    ) then
      raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
    end if;
  exception when invalid_text_representation then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end;

  normalized_command := jsonb_build_object(
    'schemaVersion', 1,
    'expectedVersion', expected_version,
    'reason', normalized_reason,
    'stops', (select jsonb_agg(jsonb_build_object(
      'clientId', lower(stop ->> 'clientId'),
      'plannedOrder', (stop ->> 'plannedOrder')::integer,
      'priority', (stop ->> 'priority')::integer
    ) order by (stop ->> 'plannedOrder')::integer) from jsonb_array_elements(stops) stop)
  );

  select * into stored_audit from private.audit_events audit
  where audit.actor_id = v_actor_id and audit.action = 'route.composition.drafted'
    and audit.request_id = p_idempotency_key;
  if found then
    if stored_audit.after_data -> 'command' <> normalized_command then
      raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT';
    end if;
    return stored_audit.after_data -> 'result';
  end if;

  select * into route_row from api.routes where id = p_route_id for update;
  if not found or not exists (
    select 1 from jsonb_array_elements_text(identity_document -> 'scopeIds') scope_id
    where scope_id::uuid = route_row.seller_id
  ) then
    raise exception using errcode = 'P0001', message = 'NOT_FOUND';
  end if;

  select * into stored_audit from private.audit_events audit
  where audit.actor_id = v_actor_id and audit.action = 'route.composition.drafted'
    and audit.request_id = p_idempotency_key;
  if found then
    if stored_audit.after_data -> 'command' <> normalized_command then
      raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT';
    end if;
    return stored_audit.after_data -> 'result';
  end if;

  if route_row.status <> 'published' or route_row.lock_version <> expected_version then
    raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT';
  end if;
  if (select count(*) from api.clients client
      where client.id = any(requested_client_ids)
        and client.status = 'active' and client.archived_at is null) <> stop_count then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;

  select * into published_row from api.route_versions version_row
  where version_row.route_id = p_route_id and version_row.status = 'published'
    and version_row.superseded_at is null for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT';
  end if;
  select coalesce(array_agg(client_id order by client_id), array[]::uuid[])
  into current_client_ids from api.route_version_stops
  where route_version_id = published_row.id;

  select coalesce(array_agg(id order by id), array[]::uuid[]) into added_ids
  from unnest(requested_client_ids) id where not (id = any(current_client_ids));
  select coalesce(array_agg(id order by id), array[]::uuid[]) into removed_ids
  from unnest(current_client_ids) id where not (id = any(requested_client_ids));
  select coalesce(array_agg(id order by id), array[]::uuid[]) into retained_ids
  from unnest(requested_client_ids) id where id = any(current_client_ids);
  v_change_summary := jsonb_build_object(
    'addedClientIds', to_jsonb(added_ids),
    'removedClientIds', to_jsonb(removed_ids),
    'retainedClientIds', to_jsonb(retained_ids),
    'added', coalesce((select jsonb_agg(jsonb_build_object('id', client.id, 'name', client.name) order by client.id)
      from api.clients client where client.id = any(added_ids)), '[]'::jsonb),
    'removed', coalesce((select jsonb_agg(jsonb_build_object(
        'id', stop_row.client_id,
        'name', stop_row.client_context_snapshot ->> 'name'
      ) order by stop_row.client_id)
      from api.route_version_stops stop_row
      where stop_row.route_version_id = published_row.id and stop_row.client_id = any(removed_ids)), '[]'::jsonb)
  );

  select * into draft_row from api.route_versions version_row
  where version_row.route_id = p_route_id and version_row.status = 'draft'
  order by version_row.version_number desc limit 1 for update;

  if found and draft_row.change_reason = normalized_reason
     and (select jsonb_agg(jsonb_build_object(
       'clientId', stop_row.client_id,
       'plannedOrder', stop_row.planned_order,
       'priority', stop_row.priority
     ) order by stop_row.planned_order) from api.route_version_stops stop_row
       where stop_row.route_version_id = draft_row.id) = normalized_command -> 'stops' then
    select jsonb_build_object(
      'schemaVersion', 1, 'routeId', p_route_id, 'routeVersionId', draft_row.id,
      'versionNumber', draft_row.version_number, 'expectedVersion', route_row.lock_version,
      'serviceDate', route_row.service_date, 'sellerId', route_row.seller_id, 'status', 'draft',
      'changed', false, 'changeReason', normalized_reason,
      'changeSummary', v_change_summary - 'added' - 'removed',
      'stops', jsonb_agg(jsonb_build_object(
        'routeVersionStopId', stop_row.id, 'clientId', stop_row.client_id,
        'plannedOrder', stop_row.planned_order, 'priority', stop_row.priority
      ) order by stop_row.planned_order)
    ) into result_document from api.route_version_stops stop_row
    where stop_row.route_version_id = draft_row.id;
    return result_document;
  end if;

  if draft_row.id is null then
    insert into api.route_versions (
      route_id, version_number, status, created_by, change_reason, change_summary
    ) values (
      p_route_id, published_row.version_number + 1, 'draft', v_actor_id,
      normalized_reason, v_change_summary
    ) returning * into draft_row;
  else
    delete from api.route_version_stops where route_version_id = draft_row.id;
    update api.route_versions set change_reason = normalized_reason, change_summary = v_change_summary
    where id = draft_row.id returning * into draft_row;
  end if;

  insert into api.route_version_stops (route_version_id, client_id, planned_order, priority)
  select draft_row.id, (stop ->> 'clientId')::uuid,
    (stop ->> 'plannedOrder')::integer, (stop ->> 'priority')::integer
  from jsonb_array_elements(normalized_command -> 'stops') stop;

  update api.routes set lock_version = lock_version + 1
  where id = p_route_id and lock_version = expected_version and status = 'published'
  returning lock_version into route_row.lock_version;
  if not found then
    raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT';
  end if;

  select jsonb_build_object(
    'schemaVersion', 1, 'routeId', p_route_id, 'routeVersionId', draft_row.id,
    'versionNumber', draft_row.version_number, 'expectedVersion', route_row.lock_version,
    'serviceDate', route_row.service_date, 'sellerId', route_row.seller_id, 'status', 'draft',
    'changed', true, 'changeReason', normalized_reason,
    'changeSummary', v_change_summary - 'added' - 'removed',
    'stops', jsonb_agg(jsonb_build_object(
      'routeVersionStopId', stop_row.id, 'clientId', stop_row.client_id,
      'plannedOrder', stop_row.planned_order, 'priority', stop_row.priority
    ) order by stop_row.planned_order)
  ) into result_document from api.route_version_stops stop_row
  where stop_row.route_version_id = draft_row.id;

  insert into private.audit_events (
    actor_id, target_type, target_id, action, before_data, after_data, reason, origin, request_id
  ) values (
    v_actor_id, 'route', p_route_id, 'route.composition.drafted',
    jsonb_build_object('publishedRouteVersionId', published_row.id,
      'versionNumber', published_row.version_number, 'expectedVersion', expected_version),
    jsonb_build_object('command', normalized_command, 'result', result_document,
      'addedClientIds', to_jsonb(added_ids), 'removedClientIds', to_jsonb(removed_ids),
      'retainedClientIds', to_jsonb(retained_ids)),
    normalized_reason, p_origin, p_idempotency_key
  );
  return result_document;
exception when unique_violation then
  raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT';
end
$function$;

create or replace function private.publish_route(p_route_id uuid, p_expected_version integer)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  identity_document jsonb := private.route_identity('route.plan_scoped');
  actor_id uuid := (identity_document ->> 'id')::uuid;
  route_row api.routes%rowtype;
  route_version_row api.route_versions%rowtype;
  previous_version_row api.route_versions%rowtype;
  publication_time timestamptz := clock_timestamp();
  seller_snapshot jsonb;
  stop_count integer;
  result_document jsonb;
begin
  if p_route_id is null or p_expected_version is null or p_expected_version < 1 then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  select * into route_row from api.routes where id = p_route_id for update;
  if not found or not exists (
    select 1 from jsonb_array_elements_text(identity_document -> 'scopeIds') scope_id
    where scope_id::uuid = route_row.seller_id
  ) then
    raise exception using errcode = 'P0001', message = 'NOT_FOUND';
  end if;
  if route_row.lock_version <> p_expected_version or route_row.status not in ('draft', 'published') then
    raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT';
  end if;
  select * into route_version_row from api.route_versions
  where route_id = p_route_id and status = 'draft'
  order by version_number desc limit 1 for update;
  if not found then raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT'; end if;

  if route_row.status = 'published' then
    select * into previous_version_row from api.route_versions
    where route_id = p_route_id and status = 'published' and superseded_at is null for update;
    if not found or route_version_row.version_number <> previous_version_row.version_number + 1
       or route_version_row.change_reason is null then
      raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT';
    end if;
  end if;

  select jsonb_build_object('id', profile.id, 'displayName', profile.display_name)
  into seller_snapshot from api.user_profiles profile
  where profile.id = route_row.seller_id and profile.status = 'active' and profile.blocked_at is null;
  if seller_snapshot is null then raise exception using errcode = 'P0001', message = 'FORBIDDEN'; end if;

  update api.route_version_stops stop_row set client_context_snapshot = jsonb_build_object(
    'id', client.id, 'externalReference', client.external_reference,
    'name', client.name, 'address', client.address,
    'latitude', case when client.location is null then null else extensions.st_y(client.location::extensions.geometry)::text end,
    'longitude', case when client.location is null then null else extensions.st_x(client.location::extensions.geometry)::text end,
    'portfolioReference', client.portfolio_reference
  ) from api.clients client where stop_row.route_version_id = route_version_row.id
    and client.id = stop_row.client_id and client.status = 'active' and client.archived_at is null;

  select count(*) into stop_count from api.route_version_stops
  where route_version_id = route_version_row.id and client_context_snapshot is not null;
  if stop_count < 1 or stop_count <> (select count(*) from api.route_version_stops where route_version_id = route_version_row.id) then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;

  if previous_version_row.id is not null then
    update api.route_versions set status = 'superseded', superseded_at = publication_time
    where id = previous_version_row.id and status = 'published' and superseded_at is null;
  end if;
  update api.route_versions set status = 'published', seller_context_snapshot = seller_snapshot,
    published_by = actor_id, published_at = publication_time
  where id = route_version_row.id and status = 'draft';
  if not found then raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT'; end if;

  if previous_version_row.id is null then
    insert into api.route_stop_executions (
      route_version_id, route_version_stop_id, execution_order, status, lock_version
    ) select route_version_row.id, stop_row.id, stop_row.planned_order, 'pending', 1
      from api.route_version_stops stop_row where stop_row.route_version_id = route_version_row.id;
  else
    insert into api.route_stop_executions (
      route_version_id, route_version_stop_id, execution_order, status, non_visit_reason_id, lock_version
    )
    select route_version_row.id, ranked.route_version_stop_id,
      row_number() over (order by ranked.group_order, ranked.within_order, ranked.route_version_stop_id)::integer,
      ranked.status, ranked.non_visit_reason_id, ranked.lock_version
    from (
      select new_stop.id as route_version_stop_id,
        case when old_execution.id is null then 1 else 0 end as group_order,
        coalesce(old_execution.execution_order, new_stop.planned_order) as within_order,
        coalesce(old_execution.status, 'pending') as status,
        old_execution.non_visit_reason_id,
        coalesce(old_execution.lock_version, 1) as lock_version
      from api.route_version_stops new_stop
      left join api.route_version_stops old_stop on old_stop.route_version_id = previous_version_row.id
        and old_stop.client_id = new_stop.client_id
      left join api.route_stop_executions old_execution on old_execution.route_version_stop_id = old_stop.id
      where new_stop.route_version_id = route_version_row.id
    ) ranked;
  end if;

  update api.routes set status = 'published', lock_version = lock_version + 1
  where id = p_route_id and lock_version = p_expected_version and status = route_row.status
  returning lock_version into route_row.lock_version;
  if not found then raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT'; end if;

  result_document := jsonb_build_object(
    'schemaVersion', 1, 'routeId', p_route_id, 'routeVersionId', route_version_row.id,
    'versionNumber', route_version_row.version_number, 'expectedVersion', route_row.lock_version,
    'status', 'published', 'publishedBy', actor_id, 'publishedAt', publication_time,
    'stopCount', stop_count
  );
  insert into private.audit_events (
    actor_id, target_type, target_id, action, before_data, after_data, reason, origin
  ) values (
    actor_id, 'route', p_route_id, 'route.published',
    jsonb_build_object('status', route_row.status, 'previousRouteVersionId', previous_version_row.id,
      'expectedVersion', p_expected_version), result_document,
    route_version_row.change_reason, 'system'
  );
  return result_document;
end
$function$;

create or replace function private.build_route_document(p_route_id uuid)
returns jsonb language sql stable security definer set search_path = ''
as $function$
  select jsonb_build_object(
    'schemaVersion', 3, 'routeId', route_row.id, 'routeVersionId', version_row.id,
    'versionNumber', version_row.version_number, 'serviceDate', route_row.service_date,
    'status', 'published', 'publishedAt', version_row.published_at,
    'executionVersion', route_row.lock_version, 'seller', version_row.seller_context_snapshot,
    'compositionChange', case when version_row.change_reason is null then null else jsonb_build_object(
      'reason', version_row.change_reason,
      'previousVersionNumber', version_row.version_number - 1,
      'added', coalesce(version_row.change_summary -> 'added', '[]'::jsonb),
      'removed', coalesce(version_row.change_summary -> 'removed', '[]'::jsonb)
    ) end,
    'stops', jsonb_agg(jsonb_build_object(
      'routeVersionStopId', stop_row.id, 'plannedOrder', stop_row.planned_order,
      'executionOrder', execution_row.execution_order, 'priority', stop_row.priority,
      'status', execution_row.status, 'executionVersion', execution_row.lock_version,
      'client', stop_row.client_context_snapshot
    ) order by execution_row.execution_order, stop_row.id)
  ) from api.routes route_row
  join api.route_versions version_row on version_row.route_id = route_row.id
    and version_row.status = 'published' and version_row.superseded_at is null
  join api.route_version_stops stop_row on stop_row.route_version_id = version_row.id
  join api.route_stop_executions execution_row on execution_row.route_version_stop_id = stop_row.id
  where route_row.id = p_route_id group by route_row.id, version_row.id;
$function$;

create or replace function private.get_my_route_for_date(p_service_date date)
returns jsonb language plpgsql stable security definer set search_path = ''
as $function$
declare
  identity_document jsonb := private.route_identity('route.read_self');
  actor_id uuid := (identity_document ->> 'id')::uuid;
  route_id uuid;
begin
  if p_service_date is null then raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED'; end if;
  select route_row.id into route_id from api.routes route_row
  where route_row.seller_id = actor_id and route_row.service_date = p_service_date
    and route_row.status = 'published';
  if route_id is null then
    return jsonb_build_object('schemaVersion', 3, 'availability', 'empty', 'serviceDate', p_service_date);
  end if;
  return jsonb_build_object('schemaVersion', 3, 'availability', 'available',
    'route', private.build_route_document(route_id));
end
$function$;

create function api.change_route_composition(
  p_route_id uuid, p_command jsonb, p_idempotency_key uuid, p_origin text
) returns jsonb language sql volatile security definer set search_path = ''
as $function$
  select private.change_route_composition(p_route_id, p_command, p_idempotency_key, p_origin);
$function$;

comment on function api.change_route_composition(uuid,jsonb,uuid,text)
  is 'Prepara a próxima composição versionada sob escopo gerencial e chave idempotente.';
comment on column api.route_versions.change_reason is 'Motivo informado pelo Gestor para a composição sucessora.';
comment on column api.route_versions.change_summary is 'Diff mínimo da composição em relação à versão publicada anterior.';

alter function private.change_route_composition(uuid,jsonb,uuid,text) owner to cirne_route_executor;
alter function api.change_route_composition(uuid,jsonb,uuid,text) owner to cirne_route_executor;
revoke all on function private.change_route_composition(uuid,jsonb,uuid,text)
  from public, anon, authenticated;
revoke all on function api.change_route_composition(uuid,jsonb,uuid,text) from public, anon;
grant execute on function api.change_route_composition(uuid,jsonb,uuid,text) to authenticated;

reset role;
revoke create on schema api, private from cirne_route_executor;
do $ownership$
begin
  execute pg_catalog.format('revoke cirne_route_executor from %I granted by current_user', current_user);
end
$ownership$;

commit;
