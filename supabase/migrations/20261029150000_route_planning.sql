-- Story 4.8: scoped route planning, recoverable draft editing and planning lookup.
begin;

select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cirne:database:migrate'));
set local lock_timeout = '5s';

do $preflight$
begin
  if to_regprocedure('private.create_route_draft(jsonb)') is null
     or to_regprocedure('private.change_route_composition(uuid,jsonb,uuid,text)') is null
     or to_regclass('api.client_seller_scopes') is null then
    raise exception 'Route planning requires route composition and client portfolio foundations';
  end if;
  if to_regprocedure('api.get_route_planning(date,uuid)') is not null then
    raise exception 'Route planning already exists';
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
create unique index audit_events_route_draft_update_idempotency_key
  on private.audit_events (actor_id, action, request_id)
  where action = 'route.draft.updated' and request_id is not null;
reset role;
revoke create on schema private from cirne_sync_executor;
do $audit_ownership$
begin
  execute pg_catalog.format('revoke cirne_sync_executor from %I granted by current_user', current_user);
end
$audit_ownership$;

create policy roles_route_planner_read on api.roles
  for select to cirne_route_executor using (true);
create policy user_role_assignments_route_planner_read on api.user_role_assignments
  for select to cirne_route_executor using (true);

do $ownership$
begin
  execute pg_catalog.format('grant cirne_route_executor to %I with set true granted by current_user', current_user);
end
$ownership$;
grant create on schema api, private to cirne_route_executor;
set local role cirne_route_executor;

create function private.assert_route_stop_portfolio(
  p_seller_id uuid,
  p_stops jsonb
) returns void language plpgsql stable security definer set search_path = ''
as $function$
declare
  stop_count integer;
begin
  if p_seller_id is null or p_stops is null or jsonb_typeof(p_stops) <> 'array' then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  stop_count := jsonb_array_length(p_stops);
  if stop_count not between 1 and 50 then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  begin
    if (select count(distinct (stop ->> 'clientId')::uuid)
        from jsonb_array_elements(p_stops) stop) <> stop_count
       or (select count(distinct (stop ->> 'plannedOrder')::integer)
           from jsonb_array_elements(p_stops) stop) <> stop_count
       or exists (
         select 1 from generate_series(1, stop_count) expected(planned_order)
         where not exists (
           select 1 from jsonb_array_elements(p_stops) stop
           where (stop ->> 'plannedOrder')::integer = expected.planned_order
         )
       ) then
      raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
    end if;
  exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end;
  if (select count(distinct scope.client_id)
      from api.client_seller_scopes scope
      join api.clients client on client.id = scope.client_id
      where scope.seller_id = p_seller_id and scope.revoked_at is null
        and client.status = 'active' and client.archived_at is null
        and scope.client_id in (
          select (stop ->> 'clientId')::uuid from jsonb_array_elements(p_stops) stop
        )) <> stop_count then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
end
$function$;

alter function private.create_route_draft(jsonb) rename to create_route_draft_legacy_unscoped;
create function private.create_route_draft(p_command jsonb)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $function$
declare
  identity_document jsonb := private.route_identity('route.plan_scoped');
  seller_id uuid;
begin
  begin
    seller_id := (p_command ->> 'sellerId')::uuid;
  exception when invalid_text_representation or null_value_not_allowed then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end;
  if not exists (
    select 1 from jsonb_array_elements_text(identity_document -> 'scopeIds') scope_id
    where scope_id::uuid = seller_id
  ) or not exists (
    select 1 from api.user_profiles profile
    where profile.id = seller_id and profile.status = 'active' and profile.blocked_at is null
  ) then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;
  perform private.assert_route_stop_portfolio(seller_id, p_command -> 'stops');
  return private.create_route_draft_legacy_unscoped(p_command);
end
$function$;

alter function private.change_route_composition(uuid,jsonb,uuid,text)
  rename to change_route_composition_legacy_unscoped;
create function private.change_route_composition(
  p_route_id uuid, p_command jsonb, p_idempotency_key uuid, p_origin text
) returns jsonb language plpgsql volatile security definer set search_path = ''
as $function$
declare
  identity_document jsonb := private.route_identity('route.plan_scoped');
  seller_id uuid;
begin
  select route_row.seller_id into seller_id from api.routes route_row where route_row.id = p_route_id;
  if seller_id is null or not exists (
    select 1 from jsonb_array_elements_text(identity_document -> 'scopeIds') scope_id
    where scope_id::uuid = seller_id
  ) then
    return private.change_route_composition_legacy_unscoped(
      p_route_id, p_command, p_idempotency_key, p_origin
    );
  end if;
  perform private.assert_route_stop_portfolio(seller_id, p_command -> 'stops');
  return private.change_route_composition_legacy_unscoped(
    p_route_id, p_command, p_idempotency_key, p_origin
  );
end
$function$;

create function private.update_route_draft(
  p_route_id uuid,
  p_command jsonb,
  p_idempotency_key uuid,
  p_origin text
) returns jsonb language plpgsql volatile security definer set search_path = ''
as $function$
declare
  identity_document jsonb := private.route_identity('route.plan_scoped');
  v_actor_id uuid := (identity_document ->> 'id')::uuid;
  route_row api.routes%rowtype;
  draft_row api.route_versions%rowtype;
  expected_version integer;
  normalized_command jsonb;
  current_stops jsonb;
  result_document jsonb;
  stored_audit private.audit_events%rowtype;
begin
  if p_route_id is null or p_idempotency_key is null or p_origin not in ('web', 'cli')
     or p_command is null or jsonb_typeof(p_command) <> 'object'
     or not (p_command ?& array['schemaVersion', 'expectedVersion', 'stops'])
     or (select count(*) from jsonb_object_keys(p_command)) <> 3
     or p_command -> 'schemaVersion' <> '1'::jsonb
     or jsonb_typeof(p_command -> 'expectedVersion') <> 'number'
     or jsonb_typeof(p_command -> 'stops') <> 'array' then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  begin
    expected_version := (p_command ->> 'expectedVersion')::integer;
  exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end;
  if expected_version < 1 or exists (
    select 1 from jsonb_array_elements(p_command -> 'stops') stop
    where jsonb_typeof(stop) <> 'object'
      or not (stop ?& array['clientId', 'plannedOrder', 'priority'])
      or (select count(*) from jsonb_object_keys(stop)) <> 3
      or jsonb_typeof(stop -> 'clientId') <> 'string'
      or stop ->> 'plannedOrder' !~ '^[0-9]+$'
      or stop ->> 'priority' !~ '^[0-9]+$'
      or (stop ->> 'priority')::integer not between 0 and 9
  ) then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  normalized_command := jsonb_build_object(
    'schemaVersion', 1,
    'expectedVersion', expected_version,
    'stops', (select jsonb_agg(jsonb_build_object(
      'clientId', lower(stop ->> 'clientId'),
      'plannedOrder', (stop ->> 'plannedOrder')::integer,
      'priority', (stop ->> 'priority')::integer
    ) order by (stop ->> 'plannedOrder')::integer)
    from jsonb_array_elements(p_command -> 'stops') stop)
  );

  select * into route_row from api.routes where id = p_route_id for update;
  if not found or not exists (
    select 1 from jsonb_array_elements_text(identity_document -> 'scopeIds') scope_id
    where scope_id::uuid = route_row.seller_id
  ) then
    raise exception using errcode = 'P0001', message = 'NOT_FOUND';
  end if;
  select * into stored_audit from private.audit_events event
  where event.actor_id = v_actor_id and event.action = 'route.draft.updated'
    and event.request_id = p_idempotency_key;
  if found then
    if stored_audit.target_id is distinct from p_route_id
       or stored_audit.after_data -> 'command' <> normalized_command then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return stored_audit.after_data -> 'result';
  end if;
  if route_row.status <> 'draft' or route_row.lock_version <> expected_version then
    raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT';
  end if;
  perform private.assert_route_stop_portfolio(route_row.seller_id, normalized_command -> 'stops');

  select * into draft_row from api.route_versions version_row
  where version_row.route_id = p_route_id and version_row.status = 'draft'
    and version_row.version_number = 1 for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT';
  end if;
  select jsonb_agg(jsonb_build_object(
    'clientId', stop_row.client_id,
    'plannedOrder', stop_row.planned_order,
    'priority', stop_row.priority
  ) order by stop_row.planned_order) into current_stops
  from api.route_version_stops stop_row where stop_row.route_version_id = draft_row.id;

  if current_stops <> normalized_command -> 'stops' then
    delete from api.route_version_stops where route_version_id = draft_row.id;
    insert into api.route_version_stops (route_version_id, client_id, planned_order, priority)
    select draft_row.id, (stop ->> 'clientId')::uuid,
      (stop ->> 'plannedOrder')::integer, (stop ->> 'priority')::integer
    from jsonb_array_elements(normalized_command -> 'stops') stop;
    update api.routes set lock_version = lock_version + 1
    where id = p_route_id and lock_version = expected_version and status = 'draft'
    returning * into route_row;
    if not found then
      raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT';
    end if;
  end if;

  select jsonb_build_object(
    'schemaVersion', 1, 'routeId', route_row.id, 'routeVersionId', draft_row.id,
    'versionNumber', draft_row.version_number, 'expectedVersion', route_row.lock_version,
    'serviceDate', route_row.service_date, 'sellerId', route_row.seller_id, 'status', 'draft',
    'stops', jsonb_agg(jsonb_build_object(
      'routeVersionStopId', stop_row.id, 'clientId', stop_row.client_id,
      'plannedOrder', stop_row.planned_order, 'priority', stop_row.priority
    ) order by stop_row.planned_order)
  ) into result_document from api.route_version_stops stop_row
  where stop_row.route_version_id = draft_row.id;

  insert into private.audit_events (
    actor_id, target_type, target_id, action, before_data, after_data, origin, request_id
  ) values (
    v_actor_id, 'route', p_route_id, 'route.draft.updated',
    jsonb_build_object('expectedVersion', expected_version, 'stops', current_stops),
    jsonb_build_object('command', normalized_command, 'result', result_document),
    p_origin, p_idempotency_key
  );
  return result_document;
exception when unique_violation then
  raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT';
end
$function$;

create function private.get_route_planning(p_service_date date, p_seller_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $function$
declare
  identity_document jsonb := private.route_identity('route.plan_scoped');
  route_row api.routes%rowtype;
  version_row api.route_versions%rowtype;
  published_version_number integer;
  planning_state text;
  seller_document jsonb;
  result_document jsonb;
begin
  if p_service_date is null or p_seller_id is null then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  if not exists (
    select 1 from jsonb_array_elements_text(identity_document -> 'scopeIds') scope_id
    where scope_id::uuid = p_seller_id
  ) then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;
  select jsonb_build_object('id', profile.id, 'displayName', profile.display_name)
  into seller_document from api.user_profiles profile
  where profile.id = p_seller_id and profile.status = 'active' and profile.blocked_at is null;
  if seller_document is null then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;
  select * into route_row from api.routes candidate
  where candidate.service_date = p_service_date and candidate.seller_id = p_seller_id;
  if not found then
    return jsonb_build_object(
      'schemaVersion', 1, 'availability', 'empty',
      'serviceDate', p_service_date, 'sellerId', p_seller_id
    );
  end if;

  select max(candidate.version_number) into published_version_number
  from api.route_versions candidate
  where candidate.route_id = route_row.id and candidate.status = 'published'
    and candidate.superseded_at is null;
  select * into version_row from api.route_versions candidate
  where candidate.route_id = route_row.id
    and candidate.status = case when exists (
      select 1 from api.route_versions draft
      where draft.route_id = route_row.id and draft.status = 'draft'
    ) then 'draft' else 'published' end
    and (candidate.status <> 'published' or candidate.superseded_at is null)
  order by candidate.version_number desc limit 1;
  if not found then
    raise exception using errcode = 'P0001', message = 'NOT_FOUND';
  end if;
  planning_state := case
    when route_row.status = 'draft' then 'initial_draft'
    when version_row.status = 'draft' then 'successor_draft'
    else 'published'
  end;

  select jsonb_build_object(
    'schemaVersion', 1,
    'availability', 'available',
    'route', jsonb_build_object(
      'routeId', route_row.id,
      'routeVersionId', version_row.id,
      'versionNumber', version_row.version_number,
      'expectedVersion', route_row.lock_version,
      'serviceDate', route_row.service_date,
      'state', planning_state,
      'seller', seller_document,
      'publishedVersionNumber', published_version_number,
      'changeReason', version_row.change_reason,
      'stops', jsonb_agg(jsonb_build_object(
        'routeVersionStopId', stop_row.id,
        'plannedOrder', stop_row.planned_order,
        'priority', stop_row.priority,
        'client', jsonb_build_object(
          'id', stop_row.client_id,
          'externalReference', coalesce(stop_row.client_context_snapshot ->> 'externalReference', client.external_reference),
          'name', coalesce(stop_row.client_context_snapshot ->> 'name', client.name),
          'address', coalesce(stop_row.client_context_snapshot ->> 'address', client.address),
          'latitude', coalesce(stop_row.client_context_snapshot -> 'latitude',
            case when client.location is null then 'null'::jsonb
              else to_jsonb(extensions.st_y(client.location::extensions.geometry)::text) end),
          'longitude', coalesce(stop_row.client_context_snapshot -> 'longitude',
            case when client.location is null then 'null'::jsonb
              else to_jsonb(extensions.st_x(client.location::extensions.geometry)::text) end),
          'portfolioReference', coalesce(stop_row.client_context_snapshot ->> 'portfolioReference', client.portfolio_reference),
          'active', client.status = 'active' and client.archived_at is null
        )
      ) order by stop_row.planned_order)
    )
  ) into result_document
  from api.route_version_stops stop_row
  join api.clients client on client.id = stop_row.client_id
  where stop_row.route_version_id = version_row.id;
  return result_document;
end
$function$;

create function private.list_management_clients(
  p_query text,
  p_page integer,
  p_page_size integer,
  p_seller_id uuid
) returns jsonb language plpgsql stable security definer set search_path = ''
as $function$
declare
  identity_document jsonb := private.route_identity('clients.read');
  search_query text := pg_catalog.left(pg_catalog.btrim(coalesce(p_query, '')), 120);
  normalized_reference text;
  search_pattern text;
  page_number integer := least(greatest(coalesce(p_page, 1), 1), 100000);
  page_size integer := least(greatest(coalesce(p_page_size, 25), 1), 100);
  result_document jsonb;
begin
  if p_seller_id is not null and not (identity_document -> 'roles' ? 'administrator')
     and not (identity_document -> 'scopeIds' ? p_seller_id::text) then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;
  normalized_reference := case when search_query = '' then ''
    else private.normalize_client_external_reference(search_query) end;
  search_pattern := '%' || pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(
    search_query, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  with visible as materialized (
    select client.*, active_scope.seller_id
    from api.clients client
    left join lateral (
      select scope.seller_id from api.client_seller_scopes scope
      where scope.client_id = client.id and scope.revoked_at is null
        and (p_seller_id is null or scope.seller_id = p_seller_id)
        and (identity_document -> 'roles' ? 'administrator'
          or identity_document -> 'scopeIds' ? scope.seller_id::text)
      order by scope.managed_by_manual_maintenance desc, scope.created_at desc, scope.id limit 1
    ) active_scope on true
    where (identity_document -> 'roles' ? 'administrator' or active_scope.seller_id is not null)
      and (p_seller_id is null or (client.status = 'active' and client.archived_at is null))
      and (search_query = '' or client.external_reference = normalized_reference
        or client.external_reference ilike search_pattern escape '\'
        or client.name ilike search_pattern escape '\'
        or client.address ilike search_pattern escape '\'
        or coalesce(client.portfolio_reference, '') ilike search_pattern escape '\')
  ), counts as (
    select pg_catalog.count(*)::integer as total_count from visible
  ), page_rows as (
    select * from visible order by name, id
    limit page_size offset (page_number - 1) * page_size
  ), documents as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'schemaVersion', 1, 'id', selected.id,
      'externalReference', selected.external_reference, 'name', selected.name,
      'address', selected.address,
      'latitude', extensions.st_y(selected.location::extensions.geometry),
      'longitude', extensions.st_x(selected.location::extensions.geometry),
      'portfolioReference', selected.portfolio_reference,
      'sellerId', selected.seller_id, 'sellerEmail', private.user_email(selected.seller_id),
      'status', case when selected.status = 'active' then 'active' else 'archived' end,
      'version', selected.lock_version
    ) order by selected.name, selected.id), '[]'::jsonb) as clients from page_rows selected
  )
  select jsonb_build_object(
    'schemaVersion', 1, 'query', search_query, 'clients', documents.clients,
    'pagination', jsonb_build_object(
      'page', page_number, 'pageSize', page_size, 'totalCount', counts.total_count,
      'totalPages', case when counts.total_count = 0 then 0
        else pg_catalog.ceil(counts.total_count::numeric / page_size)::integer end,
      'hasPrevious', page_number > 1,
      'hasNext', page_number * page_size < counts.total_count
    )
  ) into result_document from counts cross join documents;
  return result_document;
end
$function$;

create or replace function private.list_client_management_sellers()
returns jsonb language plpgsql stable security definer set search_path = ''
as $function$
declare identity_document jsonb := private.client_management_identity();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', seller.id, 'displayName', seller.display_name, 'email', private.user_email(seller.id)
    ) order by seller.display_name, seller.id)
    from api.user_profiles seller
    where seller.status = 'active' and seller.blocked_at is null
      and (identity_document -> 'roles' ? 'administrator' or exists (
        select 1 from jsonb_array_elements_text(identity_document -> 'scopeIds') scope_id
        where scope_id::uuid = seller.id
      ))
      and exists (
        select 1 from api.user_role_assignments assignment
        join api.roles role_row on role_row.id = assignment.role_id and role_row.code = 'seller'
        where assignment.user_id = seller.id and assignment.revoked_at is null
      )
  ), '[]'::jsonb);
end
$function$;

create function api.update_route_draft(
  p_route_id uuid, p_command jsonb, p_idempotency_key uuid, p_origin text
) returns jsonb language sql volatile security definer set search_path = ''
as $function$
  select private.update_route_draft(p_route_id, p_command, p_idempotency_key, p_origin);
$function$;
create function api.get_route_planning(p_service_date date, p_seller_id uuid)
returns jsonb language sql stable security definer set search_path = ''
as $function$
  select private.get_route_planning(p_service_date, p_seller_id);
$function$;
create function api.list_management_clients(
  p_query text, p_page integer, p_page_size integer, p_seller_id uuid
) returns jsonb language sql stable security definer set search_path = ''
as $function$
  select private.list_management_clients(p_query, p_page, p_page_size, p_seller_id);
$function$;

alter function private.assert_route_stop_portfolio(uuid,jsonb) owner to cirne_route_executor;
alter function private.create_route_draft(jsonb) owner to cirne_route_executor;
alter function private.change_route_composition(uuid,jsonb,uuid,text) owner to cirne_route_executor;
alter function private.update_route_draft(uuid,jsonb,uuid,text) owner to cirne_route_executor;
alter function private.get_route_planning(date,uuid) owner to cirne_route_executor;
alter function private.list_management_clients(text,integer,integer,uuid) owner to cirne_route_executor;
alter function private.list_client_management_sellers() owner to cirne_route_executor;
alter function api.update_route_draft(uuid,jsonb,uuid,text) owner to cirne_route_executor;
alter function api.get_route_planning(date,uuid) owner to cirne_route_executor;
alter function api.list_management_clients(text,integer,integer,uuid) owner to cirne_route_executor;

revoke all on function private.assert_route_stop_portfolio(uuid,jsonb),
  private.update_route_draft(uuid,jsonb,uuid,text), private.get_route_planning(date,uuid),
  private.list_management_clients(text,integer,integer,uuid)
  from public, anon, authenticated;
revoke all on function api.update_route_draft(uuid,jsonb,uuid,text),
  api.get_route_planning(date,uuid), api.list_management_clients(text,integer,integer,uuid)
  from public, anon;
grant execute on function api.update_route_draft(uuid,jsonb,uuid,text),
  api.get_route_planning(date,uuid), api.list_management_clients(text,integer,integer,uuid)
  to authenticated, service_role;

comment on function api.get_route_planning(date,uuid) is
  'Returns the scoped planning state for one seller and service date.';
comment on function api.update_route_draft(uuid,jsonb,uuid,text) is
  'Updates a never-published route draft with optimistic concurrency and idempotency.';

reset role;
revoke create on schema api, private from cirne_route_executor;
do $ownership$
begin
  execute pg_catalog.format('revoke cirne_route_executor from %I granted by current_user', current_user);
end
$ownership$;

commit;
