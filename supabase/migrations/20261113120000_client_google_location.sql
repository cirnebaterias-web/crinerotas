-- Story 4.22: Google source metadata stays separate from observed visit GPS.
begin;
select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cirne:database:migrate'));
set local lock_timeout = '5s';

-- Supabase's postgres role is not a superuser: table DDL uses its existing owner.
do $roles$ begin
  execute format('grant cirne_route_executor, cirne_visit_detail_executor to %I with set true', current_user);
end $roles$;
grant create on schema private to cirne_route_executor, cirne_visit_detail_executor;
set local role cirne_route_executor;

alter table api.clients add column google_location jsonb;
alter table api.clients add constraint clients_google_location_check check (
  google_location is null or case when jsonb_typeof(google_location) = 'object' then
    google_location ?& array['address','placeId','status','precision']
    and google_location - array['address','placeId','status','precision'] = '{}'::jsonb
    and (google_location -> 'address' = 'null'::jsonb or (
      jsonb_typeof(google_location -> 'address') = 'string'
      and char_length(google_location ->> 'address') between 1 and 500
      and btrim(google_location ->> 'address') <> ''))
    and (google_location -> 'placeId' = 'null'::jsonb or (
      jsonb_typeof(google_location -> 'placeId') = 'string'
      and char_length(google_location ->> 'placeId') between 1 and 512
      and google_location ->> 'placeId' ~ '^[A-Za-z0-9_-]+$'))
    and (google_location -> 'status' = 'null'::jsonb or (
      jsonb_typeof(google_location -> 'status') = 'string'
      and char_length(google_location ->> 'status') between 1 and 120
      and btrim(google_location ->> 'status') <> ''))
    and (google_location -> 'precision' = 'null'::jsonb or (
      jsonb_typeof(google_location -> 'precision') = 'string'
      and char_length(google_location ->> 'precision') between 1 and 80
      and btrim(google_location ->> 'precision') <> ''))
  else false end
);
comment on column api.clients.google_location is
  'Imported Q/U/P/R source metadata; not validated coordinates, arrival evidence, or observed visit GPS.';

-- Preserve existing owners, ACLs, guards and transaction semantics.
create or replace function private.execute_client_import(p_command jsonb, p_origin text default 'web')
returns jsonb language plpgsql volatile security definer set search_path = ''
as $function$
declare
  identity_document jsonb := private.client_import_identity();
  actor_id uuid := (identity_document ->> 'id')::uuid;
  existing_batch_id uuid;
  batch_id uuid;
  item jsonb;
  v_seller_id uuid;
  v_client_id uuid;
  old_client jsonb;
  accepted integer := 0;
  rejected integer := 0;
  total integer;
  row_no integer;
  row_status text;
  latitude_value double precision;
  longitude_value double precision;
begin
  if p_command is null
     or jsonb_typeof(p_command) is distinct from 'object'
     or jsonb_typeof(p_command -> 'schemaVersion') is distinct from 'number'
     or p_command -> 'schemaVersion' is distinct from '1'::jsonb
     or jsonb_typeof(p_command -> 'totalCount') is distinct from 'number'
     or coalesce(p_command ->> 'totalCount', '') !~ '^[0-9]+$'
     or (p_command ->> 'totalCount')::numeric > 5000
     or jsonb_typeof(p_command -> 'sourceName') is distinct from 'string'
     or char_length(btrim(p_command ->> 'sourceName')) not between 1 and 255
     or coalesce(p_command ->> 'sourceChecksum','') !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(p_command -> 'rows') is distinct from 'array'
     or jsonb_typeof(p_command -> 'issues') is distinct from 'array' then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  if p_origin is null or p_origin not in ('web', 'cli') then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  total := (p_command ->> 'totalCount')::integer;
  if jsonb_array_length(p_command -> 'rows') > 5000
     or jsonb_array_length(p_command -> 'issues') > 10000 then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_command -> 'rows') row_item
    where jsonb_typeof(row_item) is distinct from 'object'
      or jsonb_typeof(row_item -> 'rowNumber') is distinct from 'number'
      or coalesce(row_item ->> 'rowNumber', '') !~ '^[0-9]+$'
      or (row_item ->> 'rowNumber')::numeric < 2
  ) or exists (
    select 1 from jsonb_array_elements(p_command -> 'issues') issue_item
    where jsonb_typeof(issue_item) is distinct from 'object'
      or jsonb_typeof(issue_item -> 'rowNumber') is distinct from 'number'
      or coalesce(issue_item ->> 'rowNumber', '') !~ '^[0-9]+$'
      or (issue_item ->> 'rowNumber')::numeric < 1
  ) or (
    select count(*) <> count(distinct row_item ->> 'rowNumber')
    from jsonb_array_elements(p_command -> 'rows') row_item
  ) or exists (
    select 1
    from jsonb_array_elements(p_command -> 'rows') row_item
    join jsonb_array_elements(p_command -> 'issues') issue_item
      on issue_item ->> 'rowNumber' = row_item ->> 'rowNumber'
  ) then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  if (
    select count(distinct numbered.row_number)
    from (
      select row_item ->> 'rowNumber' as row_number
      from jsonb_array_elements(p_command -> 'rows') row_item
      union all
      select issue_item ->> 'rowNumber'
      from jsonb_array_elements(p_command -> 'issues') issue_item
      where (issue_item ->> 'rowNumber')::integer > 1
    ) numbered
  ) <> total then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;

  select id into existing_batch_id from api.import_batches
  where imported_by = actor_id and source_checksum = p_command ->> 'sourceChecksum';
  if existing_batch_id is not null then
    return private.client_import_batch_document(existing_batch_id, true);
  end if;

  insert into api.import_batches (source_name, source_checksum, imported_by, status, total_count)
  values (pg_catalog.left(p_command ->> 'sourceName', 255), p_command ->> 'sourceChecksum',
    actor_id, 'processing', total)
  returning id into batch_id;

  for item in select value from jsonb_array_elements(p_command -> 'issues') loop
    row_no := greatest(coalesce((item ->> 'rowNumber')::integer, 1), 1);
    insert into private.import_batch_rows (import_batch_id, row_number, payload, status, error_codes)
    values (batch_id, row_no, '{}'::jsonb, 'rejected', jsonb_build_array(jsonb_build_object(
      'code', pg_catalog.left(coalesce(item ->> 'code','INVALID_ROW'),80),
      'message', pg_catalog.left(coalesce(item ->> 'message','Linha inválida.'),300))))
    on conflict (import_batch_id, row_number) do update
      set error_codes = private.import_batch_rows.error_codes || excluded.error_codes;
  end loop;

  for item in select value from jsonb_array_elements(p_command -> 'rows') loop
    row_no := (item ->> 'rowNumber')::integer;
    begin
      v_seller_id := private.valid_import_seller(item ->> 'sellerEmail');
      if v_seller_id is null
         or not private.import_seller_authorized(identity_document, v_seller_id) then
        raise exception using errcode = 'P0001', message = 'SELLER_NOT_FOUND';
      end if;
      row_status := coalesce(item ->> 'status', 'active');
      if row_status not in ('active','archived') then
        raise exception using errcode = 'P0001', message = 'INVALID_STATUS';
      end if;
      latitude_value := nullif(item ->> 'latitude','')::double precision;
      longitude_value := nullif(item ->> 'longitude','')::double precision;

      select to_jsonb(client), client.id into old_client, v_client_id
      from api.clients client where client.external_reference = item ->> 'externalReference'
      for update;

      if v_client_id is not null
         and not (identity_document -> 'roles' ? 'administrator')
         and not exists (
           select 1 from api.client_seller_scopes scope
           where scope.client_id = v_client_id and scope.revoked_at is null
             and identity_document -> 'scopeIds' ? scope.seller_id::text
         ) then
        raise exception using errcode = 'P0001', message = 'CLIENT_OUT_OF_SCOPE';
      end if;

      if v_client_id is null then
        insert into api.clients (external_reference, name, address, location, portfolio_reference,
          status, created_from_import_batch_id, archived_at, google_location)
        values (item ->> 'externalReference', item ->> 'name', item ->> 'address',
          case when latitude_value is null then null else
            extensions.st_setsrid(extensions.st_makepoint(longitude_value, latitude_value),4326)::extensions.geography end,
          nullif(item ->> 'portfolioReference',''),
          case when row_status = 'archived' then 'inactive' else 'active' end,
          batch_id, case when row_status = 'archived' then now() else null end, item -> 'googleLocation')
        returning id into v_client_id;
      else
        update api.clients set
          name = item ->> 'name', address = item ->> 'address',
          google_location = case when item ? 'googleLocation' then item -> 'googleLocation' else google_location end,
          location = case when latitude_value is null then null else
            extensions.st_setsrid(extensions.st_makepoint(longitude_value, latitude_value),4326)::extensions.geography end,
          portfolio_reference = nullif(item ->> 'portfolioReference',''),
          status = case when row_status = 'archived' then 'inactive' else 'active' end,
          archived_at = case when row_status = 'archived' then coalesce(archived_at, now()) else null end
        where id = v_client_id;
      end if;

      perform private.apply_import_client_scope(v_client_id, v_seller_id, actor_id, batch_id);

      insert into private.audit_events
        (actor_id, target_type, target_id, action, before_data, after_data, origin)
      values (actor_id, 'client', v_client_id, 'client.imported', old_client,
        jsonb_build_object('externalReference', item ->> 'externalReference', 'batchId', batch_id,
          'sellerId', v_seller_id, 'status', row_status,
          'googleLocation', (select client.google_location from api.clients client where client.id = v_client_id)), p_origin);

      insert into private.import_batch_rows (import_batch_id, row_number, payload, status)
      values (batch_id, row_no, item - 'sellerEmail', 'accepted');
      accepted := accepted + 1;
    exception when others then
      insert into private.import_batch_rows (import_batch_id, row_number, payload, status, error_codes)
      values (batch_id, row_no, item - 'sellerEmail', 'rejected', jsonb_build_array(jsonb_build_object(
        'code', case when sqlerrm in ('SELLER_NOT_FOUND','INVALID_STATUS','CLIENT_OUT_OF_SCOPE') then sqlerrm else 'ROW_FAILED' end,
        'message', case when sqlerrm = 'SELLER_NOT_FOUND' then 'Vendedor inexistente, inativo ou sem papel de Vendedor.'
          when sqlerrm = 'INVALID_STATUS' then 'Status inválido.'
          when sqlerrm = 'CLIENT_OUT_OF_SCOPE' then 'Cliente fora da abrangência do Gestor.'
          else 'A linha não pôde ser importada.' end)))
      on conflict (import_batch_id, row_number) do update set
        status = 'rejected',
        error_codes = private.import_batch_rows.error_codes || excluded.error_codes;
      rejected := rejected + 1;
    end;
  end loop;

  select count(*) into rejected from private.import_batch_rows
  where import_batch_id = batch_id and status = 'rejected';
  update api.import_batches set accepted_count = accepted, rejected_count = rejected,
    total_count = accepted + rejected,
    status = case when rejected > 0 then 'completed_with_rejections' else 'completed' end,
    completed_at = now()
  where id = batch_id;
  return private.client_import_batch_document(batch_id, false);
exception when unique_violation then
  select id into existing_batch_id from api.import_batches
  where imported_by = actor_id and source_checksum = p_command ->> 'sourceChecksum';
  if existing_batch_id is not null then
    return private.client_import_batch_document(existing_batch_id, true);
  end if;
  raise;
end
$function$;

create or replace function private.client_management_document(p_client_id uuid, p_identity jsonb)
returns jsonb language sql stable security definer set search_path = ''
as $function$
  select jsonb_build_object(
    'schemaVersion', 1,
    'id', client.id,
    'externalReference', client.external_reference,
    'name', client.name,
    'address', client.address,
    'googleLocation', client.google_location,
    'latitude', extensions.st_y(client.location::extensions.geometry),
    'longitude', extensions.st_x(client.location::extensions.geometry),
    'portfolioReference', client.portfolio_reference,
    'sellerId', selected_scope.seller_id,
    'sellerEmail', private.user_email(selected_scope.seller_id),
    'status', case when client.status = 'active' then 'active' else 'archived' end,
    'version', client.lock_version
  )
  from api.clients client
  left join lateral (
    select scope.seller_id
    from api.client_seller_scopes scope
    where scope.client_id = client.id and scope.revoked_at is null
      and (p_identity -> 'roles' ? 'administrator'
        or p_identity -> 'scopeIds' ? scope.seller_id::text)
    order by scope.managed_by_manual_maintenance desc, scope.created_at desc, scope.id
    limit 1
  ) selected_scope on true
  where client.id = p_client_id
    and (p_identity -> 'roles' ? 'administrator' or selected_scope.seller_id is not null);
$function$;

create or replace function private.list_management_clients(
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
      'googleLocation', selected.google_location,
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

create or replace function private.list_import_clients(p_limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path = ''
as $function$
declare
  identity_document jsonb := private.route_identity('clients.read');
begin
  return coalesce((select jsonb_agg(jsonb_build_object(
    'id', selected.id, 'externalReference', selected.external_reference, 'name', selected.name,
    'googleLocation', selected.google_location,
    'address', selected.address, 'latitude', extensions.st_y(selected.location::extensions.geometry),
    'longitude', extensions.st_x(selected.location::extensions.geometry),
    'portfolioReference', selected.portfolio_reference, 'sellerEmail', private.user_email(selected.seller_id),
    'status', case when selected.status = 'active' then 'active' else 'archived' end
  ) order by selected.name, selected.id)
  from (
    select client.*, active_scope.seller_id
    from api.clients client
    left join lateral (
      select scope.seller_id from api.client_seller_scopes scope
      where scope.client_id = client.id and scope.revoked_at is null
        and (identity_document -> 'roles' ? 'administrator'
          or identity_document -> 'scopeIds' ? scope.seller_id::text)
      order by scope.created_at desc limit 1
    ) active_scope on true
    where identity_document -> 'roles' ? 'administrator'
      or (active_scope.seller_id is not null
        and identity_document -> 'scopeIds' ? active_scope.seller_id::text)
    order by client.name, client.id
    limit least(greatest(p_limit,1),100)
  ) selected), '[]'::jsonb);
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
    'googleLocation', client.google_location,
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

create or replace function private.get_route_planning(p_service_date date, p_seller_id uuid)
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
          -- A legacy published snapshot must not inherit today's source metadata.
          'googleLocation', case when version_row.status = 'draft' then client.google_location
            else stop_row.client_context_snapshot -> 'googleLocation' end,
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

reset role;
set local role cirne_visit_detail_executor;

create or replace function private.get_visit_detail(p_visit_id uuid, p_request_id uuid, p_origin text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $function$
declare
  identity_document jsonb := private.visit_detail_identity(p_visit_id);
  visit_row api.visits%rowtype;
  location_allowed boolean := identity_document -> 'capabilities' @> '["visit.location.read_scoped"]'::jsonb;
  evidence_allowed boolean := identity_document -> 'capabilities' @> '["visit.evidence.read_scoped"]'::jsonb;
  location_document jsonb := jsonb_build_object('state', 'withheld');
  evidence_document jsonb := jsonb_build_object('state', 'withheld');
  result_document jsonb;
begin
  if p_request_id is null or p_origin not in ('web', 'cli') then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  select * into strict visit_row from api.visits where id = p_visit_id;

  if location_allowed then
    select coalesce((select jsonb_build_object(
      'state', 'available',
      'latitude', extensions.st_y(event.position::extensions.geometry)::text,
      'longitude', extensions.st_x(event.position::extensions.geometry)::text,
      'accuracyM', event.accuracy_m::text,
      'distanceM', event.distance_m::text,
      'capturedAt', event.device_captured_at
    ) from api.location_events event
      where event.visit_id = visit_row.id and event.position is not null
      order by event.device_captured_at desc, event.id desc limit 1),
      jsonb_build_object('state', 'unknown_to_server')) into location_document;
    insert into private.audit_events (
      actor_id, target_type, target_id, action, before_data, after_data, origin, request_id, occurred_at
    ) values (
      (identity_document ->> 'id')::uuid, 'visit', visit_row.id, 'visit.location.read.v1',
      null, jsonb_build_object('authorized', true), p_origin, p_request_id, clock_timestamp()
    );
  end if;

  if evidence_allowed then
    select jsonb_build_object('state', 'available', 'items', coalesce(jsonb_agg(item.document order by item.captured_at, item.id), '[]'::jsonb))
    into evidence_document from (
      select attachment.id, attachment.captured_at, jsonb_build_object(
        'id', attachment.id, 'purpose', attachment.purpose, 'contentType', attachment.content_type,
        'byteSize', attachment.byte_size, 'capturedAt', attachment.captured_at,
        'verifiedAt', attachment.verified_at,
        'downloadUrlPath', '/api/v1/attachments/' || attachment.id || '/download-url'
      ) as document
      from api.visit_attachments attachment
      where attachment.visit_id = visit_row.id and attachment.status = 'verified'
      union all
      select attachment.id, attachment.captured_at, jsonb_build_object(
        'id', attachment.id, 'purpose', 'scrap_receipt', 'contentType', attachment.content_type,
        'byteSize', attachment.byte_size, 'capturedAt', attachment.captured_at,
        'verifiedAt', attachment.verified_at,
        'downloadUrlPath', '/api/v1/attachments/' || attachment.id || '/download-url'
      ) as document
      from api.scrap_attachments attachment
      join api.scrap_collections collection on collection.id = attachment.collection_id
      join api.scrap_reports report on report.id = collection.report_id
      where report.visit_id = visit_row.id and attachment.status = 'verified'
      order by captured_at, id limit 20
    ) item;
  end if;

  select jsonb_build_object(
    'schemaVersion', 1,
    'visitId', visit_row.id,
    'context', jsonb_build_object(
      'serviceDate', visit_row.context_snapshot #>> '{route,serviceDate}',
      'route', jsonb_build_object(
        'id', (visit_row.context_snapshot #>> '{route,id}')::uuid,
        'versionId', visit_row.route_version_id,
        'versionNumber', (visit_row.context_snapshot #>> '{route,versionNumber}')::integer
      ),
      'stop', jsonb_build_object(
        'id', visit_row.route_version_stop_id,
        'plannedOrder', (visit_row.context_snapshot #>> '{route,plannedOrder}')::integer,
        'priority', (visit_row.context_snapshot #>> '{route,priority}')::integer
      ),
      'client', jsonb_build_object(
        'id', visit_row.client_id,
        'externalReference', visit_row.context_snapshot #>> '{client,externalReference}',
        'name', visit_row.context_snapshot #>> '{client,name}',
        'address', visit_row.context_snapshot #>> '{client,address}',
        'googleLocation', visit_row.context_snapshot #> '{client,googleLocation}'
      ),
      'seller', jsonb_build_object(
        'id', visit_row.seller_id,
        'displayName', visit_row.context_snapshot #>> '{seller,displayName}'
      ),
      'parameterSet', jsonb_build_object(
        'id', visit_row.parameter_set_id,
        'version', (visit_row.context_snapshot #>> '{parameters,version}')::integer
      )
    ),
    'status', visit_row.status,
    'deviceStartedAt', visit_row.device_started_at,
    'serverStartedAt', visit_row.server_started_at,
    'deviceCompletedAt', visit_row.device_completed_at,
    'serverCompletedAt', visit_row.server_completed_at,
    'lastKnownUpdateAt', greatest(
      visit_row.updated_at,
      coalesce((select max(event.updated_at) from private.sync_events event
        where event.canonical_result ->> 'canonicalId' = visit_row.id::text), visit_row.updated_at)
    ),
    'serverVisibilityNote',
      'Somente dados recebidos e confirmados pelo servidor estão presentes; conteúdo ainda apenas no aparelho não é conhecido.',
    'sections', jsonb_build_object(
      'stock', coalesce((select jsonb_build_object(
        'state', 'available', 'recordedAt', stock.server_saved_at,
        'heliarQuantity', stock.heliar_quantity, 'mouraQuantity', stock.moura_quantity,
        'ownLines', coalesce(stock.details -> 'ownLines', '[]'::jsonb),
        'competitorLines', coalesce(stock.details -> 'competitorLines', '[]'::jsonb),
        'observation', stock.observation
      ) from api.stock_snapshots stock where stock.visit_id = visit_row.id), jsonb_build_object('state', 'absent')),
      'competitorPrices', coalesce((select jsonb_build_object(
        'state', 'available', 'recordedAt', report.server_saved_at,
        'availability', report.availability,
        'unavailableReason', case when reason.id is null then null else jsonb_build_object('id', reason.id, 'label', reason.label) end,
        'quotations', coalesce((select jsonb_agg(jsonb_build_object(
          'id', price.id,
          'competitor', jsonb_build_object('id', price.competitor_id, 'label', competitor.label),
          'productCode', price.product_code,
          'modelOrAmperage', price.model_or_amperage,
          'technology', jsonb_build_object('id', price.technology_id, 'label', technology.label),
          'priceBrl', price.price_brl::text,
          'condition', jsonb_build_object('id', price.condition_id, 'label', condition.label),
          'observation', price.observation
        ) order by price.ordinal) from api.competitor_prices price
          join api.parameter_values competitor on competitor.id = price.competitor_id
          join api.parameter_values technology on technology.id = price.technology_id
          join api.parameter_values condition on condition.id = price.condition_id
          where price.report_id = report.id), '[]'::jsonb)
      ) from api.competitor_price_reports report
        left join api.parameter_values reason on reason.id = report.unavailable_reason_id
        where report.visit_id = visit_row.id), jsonb_build_object('state', 'absent')),
      'commercialActions', coalesce((select jsonb_build_object(
        'state', 'available', 'recordedAt', report.server_saved_at,
        'ownAcknowledgements', coalesce((select jsonb_agg(jsonb_build_object(
          'actionId', acknowledgement.commercial_action_id, 'title', acknowledgement.title_snapshot,
          'presented', acknowledgement.presented
        ) order by acknowledgement.ordinal) from api.visit_own_action_acknowledgements acknowledgement
          where acknowledgement.report_id = report.id), '[]'::jsonb),
        'competitor', jsonb_build_object(
          'availability', report.competitor_availability,
          'actions', coalesce((select jsonb_agg(jsonb_build_object(
            'id', action.id, 'competitorId', action.competitor_id,
            'actionType', case when action.action_type = 'other' then action.other_type else action.action_type end,
            'description', action.description, 'validFrom', action.valid_from, 'validUntil', action.valid_until
          ) order by action.ordinal) from api.visit_competitor_commercial_actions action
            where action.report_id = report.id), '[]'::jsonb)
        )
      ) from api.visit_commercial_action_reports report where report.visit_id = visit_row.id), jsonb_build_object('state', 'absent')),
      'scrap', coalesce((select jsonb_build_object(
        'state', 'available', 'recordedAt', report.device_saved_at,
        'availability', report.availability,
        'collectedWeightKg', collection.actual_weight_kg::text,
        'scheduledWeightKg', schedule.estimated_weight_kg::text,
        'collection', case when collection.id is null then null else jsonb_build_object(
          'id', collection.id, 'collectedAt', collection.collected_at,
          'receiptNumber', collection.receipt_number, 'destinationName', collection.destination_name_snapshot
        ) end,
        'schedule', case when schedule.id is null then null else jsonb_build_object(
          'id', schedule.id, 'desiredDate', schedule.desired_date, 'period', schedule.period,
          'status', schedule.status, 'observation', schedule.observation
        ) end
      ) from api.scrap_reports report
        left join api.scrap_collections collection on collection.report_id = report.id
        left join api.pickup_schedules schedule on schedule.report_id = report.id
        where report.visit_id = visit_row.id), jsonb_build_object('state', 'absent')),
      'result', case when visit_row.status = 'completed' then jsonb_build_object(
        'state', 'available', 'outcome', 'completed',
        'deviceCompletedAt', visit_row.device_completed_at,
        'serverCompletedAt', visit_row.server_completed_at
      ) else jsonb_build_object('state', 'absent') end
    ),
    'synchronization', coalesce((select jsonb_build_object(
      'status', coalesce(failure.status, event.status),
      'occurredAt', event.occurred_at, 'receivedAt', event.updated_at,
      'confirmedAt', event.confirmed_at,
      'attemptCount', greatest(event.attempt_count, coalesce(failure.attempt_count, 1)),
      'lastErrorCode', failure.error_code
    ) from private.sync_events event
      left join private.sync_failure_observations failure
        on failure.actor_id = event.actor_id and failure.device_id = event.device_id and failure.event_id = event.event_id
      where event.canonical_result ->> 'canonicalId' = visit_row.id::text
      order by event.updated_at desc, event.id desc limit 1), jsonb_build_object(
        'status', 'confirmed', 'occurredAt', visit_row.device_started_at,
        'receivedAt', visit_row.server_started_at, 'confirmedAt', visit_row.server_started_at,
        'attemptCount', 1, 'lastErrorCode', null
      )),
    'exceptions', coalesce((select jsonb_agg(jsonb_build_object(
      'kind', bounded_issue.kind,
      'message', case bounded_issue.kind
        when 'camera_unavailable' then 'A câmera não estava disponível; a visita continuou com justificativa.'
        when 'gps_unavailable' then 'A localização não estava disponível; a visita continuou com justificativa.'
        when 'gps_low_accuracy' then 'A precisão da localização estava reduzida no momento do registro.'
        when 'outside_radius' then 'O registro ocorreu fora do raio esperado e foi justificado.'
        else 'A localização cadastrada do cliente não estava disponível.' end,
      'capturedAt', bounded_issue.device_captured_at
    ) order by bounded_issue.device_captured_at, bounded_issue.kind) from (
      select event.device_captured_at, issue.kind
      from api.location_events event
      cross join lateral unnest(event.issues) issue(kind)
      where event.visit_id = visit_row.id
      order by event.device_captured_at, issue.kind
      limit 10
    ) bounded_issue), '[]'::jsonb),
    'location', location_document,
    'evidence', evidence_document,
    'timeline', coalesce((select jsonb_agg(jsonb_build_object(
      'action', audit.action,
      'origin', case when audit.origin in ('web','pwa','cli','system') then audit.origin else 'system' end,
      'occurredAt', audit.occurred_at
    ) order by audit.occurred_at, audit.id) from (
      select event.* from private.audit_events event
      where event.target_type = 'visit' and event.target_id = visit_row.id
      order by event.occurred_at desc, event.id desc limit 100
    ) audit), '[]'::jsonb)
  ) into result_document;
  return result_document;
end
$function$;

reset role;
revoke create on schema private from cirne_route_executor, cirne_visit_detail_executor;
do $roles$ begin
  execute format('revoke cirne_route_executor, cirne_visit_detail_executor from %I granted by current_user', current_user);
end $roles$;
notify pgrst, 'reload schema';
commit;
