-- Story 4.15 / REL-415-001. Pin catalog absence as part of the public CRM cursor.
begin;
select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cirne:database:migrate'));
set local lock_timeout='5s';

do $membership$
begin
  execute pg_catalog.format('grant cirne_route_executor to %I with set true granted by current_user',current_user);
end
$membership$;
grant usage,create on schema api,private to cirne_route_executor;

create function private.product_catalog_client_context(p_client_id uuid,p_sales_generation_id uuid,
  p_catalog_generation_id uuid,p_catalog_state text,p_as_of_date date,p_client_version integer)
returns jsonb language plpgsql stable security definer set search_path=''
as $function$
declare sales_context jsonb; catalog_run private.product_catalog_sync_runs;
  catalog_available boolean:=false;
begin
  if p_catalog_state is not null and p_catalog_state not in ('available','catalog_unavailable') then
    raise exception using errcode='P0001',message='VALIDATION_FAILED';
  end if;
  if p_sales_generation_id is null then
    if p_catalog_generation_id is not null or p_catalog_state is not null
      or p_as_of_date is not null or p_client_version is not null then
      raise exception using errcode='P0001',message='VALIDATION_FAILED';
    end if;
  elsif p_as_of_date is null or p_client_version is null or p_catalog_state is null
    or (p_catalog_state='available') is distinct from (p_catalog_generation_id is not null) then
    raise exception using errcode='P0001',message='VALIDATION_FAILED';
  end if;

  sales_context:=private.sales_client_context(p_client_id,p_sales_generation_id);
  if p_as_of_date is not null and p_as_of_date<>(sales_context->>'asOfDate')::date then
    raise exception using errcode='P0001',message='VERSION_CONFLICT';
  end if;
  if p_client_version is not null and p_client_version<>(sales_context->>'clientVersion')::integer then
    raise exception using errcode='P0001',message='VERSION_CONFLICT';
  end if;
  select run.* into catalog_run from private.product_catalog_sources source
    join private.product_catalog_sync_runs run on run.id=source.published_run_id
    where run.status='published';
  catalog_available:=found;
  if not catalog_available then
    if p_catalog_state='available' or p_catalog_generation_id is not null then
      raise exception using errcode='P0001',message='VERSION_CONFLICT';
    end if;
    return jsonb_build_object('salesGenerationId',sales_context->'generationId',
      'fetchedAt',sales_context->'fetchedAt','publishedAt',sales_context->'publishedAt',
      'observedFrom',sales_context->'observedFrom','observedThrough',sales_context->'observedThrough',
      'catalogGenerationId',null,'asOfDate',sales_context->'asOfDate',
      'clientVersion',sales_context->'clientVersion','client',sales_context->'client',
      'reference',sales_context->'reference','catalog',jsonb_build_object('status','catalog_unavailable'));
  end if;
  if p_catalog_state='catalog_unavailable'
    or (p_catalog_generation_id is not null and p_catalog_generation_id<>catalog_run.id) then
    raise exception using errcode='P0001',message='VERSION_CONFLICT';
  end if;
  return jsonb_build_object('salesGenerationId',sales_context->'generationId',
    'fetchedAt',sales_context->'fetchedAt','publishedAt',sales_context->'publishedAt',
    'observedFrom',sales_context->'observedFrom','observedThrough',sales_context->'observedThrough',
    'catalogGenerationId',catalog_run.id,'asOfDate',sales_context->'asOfDate',
    'clientVersion',sales_context->'clientVersion','client',sales_context->'client',
    'reference',sales_context->'reference','catalog',jsonb_build_object('status','available',
      'generationId',catalog_run.id,'fetchedAt',catalog_run.fetched_at,'publishedAt',catalog_run.completed_at,
      'rowCount',catalog_run.source_row_count,'contentHash',catalog_run.content_hash));
end
$function$;

drop function api.get_client_sales_catalog_context(uuid,uuid,uuid,date,integer);
create function api.get_client_sales_catalog_context(p_client_id uuid,p_sales_snapshot_id uuid default null,
  p_catalog_snapshot_id uuid default null,p_catalog_state text default null,
  p_as_of_date date default null,p_client_version integer default null)
returns jsonb language sql stable security definer set search_path=''
as $function$
  select private.product_catalog_client_context(p_client_id,p_sales_snapshot_id,p_catalog_snapshot_id,
    p_catalog_state,p_as_of_date,p_client_version)-'reference';
$function$;

comment on function api.get_client_sales_catalog_context(uuid,uuid,uuid,text,date,integer) is
  'Current-scope CRM context. A pinned cursor explicitly records available or catalog_unavailable so pages cannot adopt a newly published catalog.';

alter function private.product_catalog_client_context(uuid,uuid,uuid,text,date,integer)
  owner to cirne_route_executor;
alter function api.get_client_sales_catalog_context(uuid,uuid,uuid,text,date,integer)
  owner to cirne_route_executor;
revoke all on function private.product_catalog_client_context(uuid,uuid,uuid,text,date,integer)
  from public,anon,authenticated,service_role;
revoke all on function api.get_client_sales_catalog_context(uuid,uuid,uuid,text,date,integer)
  from public,anon,authenticated,service_role;
grant execute on function api.get_client_sales_catalog_context(uuid,uuid,uuid,text,date,integer)
  to authenticated;

revoke create on schema api,private from cirne_route_executor;
do $membership$
begin
  execute pg_catalog.format('revoke cirne_route_executor from %I granted by current_user',current_user);
end
$membership$;
commit;
