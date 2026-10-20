-- Story 3.12 QA fix: searchable, paginated management listing.
-- Rollback is forward-only: revoke the API wrapper first, then remove both
-- functions in a later migration after deployed callers stop using them.
begin;

select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cirne:database:migrate'));
set local lock_timeout = '5s';

do $membership$
begin
  execute pg_catalog.format('grant cirne_route_executor to %I with set true granted by current_user', current_user);
end
$membership$;
grant usage, create on schema api, private to cirne_route_executor;

create or replace function private.list_management_clients(
  p_query text default '',
  p_page integer default 1,
  p_page_size integer default 25
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
  normalized_reference := case when search_query = '' then ''
    else private.normalize_client_external_reference(search_query) end;
  search_pattern := '%' || pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(
    search_query, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  with visible as materialized (
    select client.*, active_scope.seller_id
    from api.clients client
    left join lateral (
      select scope.seller_id
      from api.client_seller_scopes scope
      where scope.client_id = client.id
        and scope.revoked_at is null
        and (identity_document -> 'roles' ? 'administrator'
          or identity_document -> 'scopeIds' ? scope.seller_id::text)
      order by scope.managed_by_manual_maintenance desc, scope.created_at desc, scope.id
      limit 1
    ) active_scope on true
    where (
      identity_document -> 'roles' ? 'administrator'
      or (active_scope.seller_id is not null
        and identity_document -> 'scopeIds' ? active_scope.seller_id::text)
    ) and (
      search_query = ''
      or client.external_reference = normalized_reference
      or client.external_reference ilike search_pattern escape '\'
      or client.name ilike search_pattern escape '\'
      or client.address ilike search_pattern escape '\'
      or coalesce(client.portfolio_reference, '') ilike search_pattern escape '\'
    )
  ), counts as (
    select pg_catalog.count(*)::integer as total_count from visible
  ), page_rows as (
    select * from visible
    order by name, id
    limit page_size offset (page_number - 1) * page_size
  ), documents as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'schemaVersion', 1,
      'id', selected.id,
      'externalReference', selected.external_reference,
      'name', selected.name,
      'address', selected.address,
      'latitude', extensions.st_y(selected.location::extensions.geometry),
      'longitude', extensions.st_x(selected.location::extensions.geometry),
      'portfolioReference', selected.portfolio_reference,
      'sellerId', selected.seller_id,
      'sellerEmail', private.user_email(selected.seller_id),
      'status', case when selected.status = 'active' then 'active' else 'archived' end,
      'version', selected.lock_version
    ) order by selected.name, selected.id), '[]'::jsonb) as clients
    from page_rows selected
  )
  select jsonb_build_object(
    'schemaVersion', 1,
    'query', search_query,
    'clients', documents.clients,
    'pagination', jsonb_build_object(
      'page', page_number,
      'pageSize', page_size,
      'totalCount', counts.total_count,
      'totalPages', case when counts.total_count = 0 then 0
        else pg_catalog.ceil(counts.total_count::numeric / page_size)::integer end,
      'hasPrevious', page_number > 1,
      'hasNext', page_number * page_size < counts.total_count
    )
  ) into result_document
  from counts cross join documents;

  return result_document;
end
$function$;

create or replace function api.list_management_clients(
  p_query text default '',
  p_page integer default 1,
  p_page_size integer default 25
) returns jsonb language sql stable security definer set search_path = ''
as $function$
  select private.list_management_clients(p_query, p_page, p_page_size);
$function$;

alter function private.list_management_clients(text,integer,integer) owner to cirne_route_executor;
alter function api.list_management_clients(text,integer,integer) owner to cirne_route_executor;

revoke all on function private.list_management_clients(text,integer,integer)
  from public, anon, authenticated;
revoke all on function api.list_management_clients(text,integer,integer)
  from public, anon;
grant execute on function api.list_management_clients(text,integer,integer)
  to authenticated, service_role;

comment on function api.list_management_clients(text,integer,integer) is
  'Lists only authorized clients with server-side search and bounded pagination.';

revoke create on schema api, private from cirne_route_executor;
do $membership$
begin
  execute pg_catalog.format('revoke cirne_route_executor from %I granted by current_user', current_user);
end
$membership$;

commit;
