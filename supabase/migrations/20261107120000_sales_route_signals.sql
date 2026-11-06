-- Story 4.14 / ADR 006: bounded, read-only signals for the current sales generation.
-- No historical salesperson, import authority or administrator role expands read scope.
begin;
select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cirne:database:migrate'));
set local lock_timeout='5s';

do $membership$
begin execute format('grant cirne_route_executor to %I with set true granted by current_user',current_user); end
$membership$;
grant usage,create on schema api,private to cirne_route_executor;
set local role cirne_route_executor;

create or replace function private.sales_client_context(p_client_id uuid,p_snapshot_id uuid)
returns jsonb language plpgsql stable security definer set search_path=''
as $function$
declare identity_document jsonb:=private.route_identity('sales.read_client'); c api.clients; r private.sales_sync_runs;
begin
  -- Client authorization comes first, so availability never reveals another portfolio.
  select * into c from api.clients client where client.id=p_client_id and exists(
    select 1 from api.client_seller_scopes scope where scope.client_id=client.id and scope.revoked_at is null
      and identity_document->'scopeIds' ? scope.seller_id::text);
  if not found then raise exception using errcode='P0001',message='NOT_FOUND'; end if;
  select run.* into r from private.sales_sources source join private.sales_sync_runs run on run.id=source.published_run_id
    where run.status='published';
  if not found then raise exception using errcode='P0001',message='SALES_UNAVAILABLE'; end if;
  if p_snapshot_id is not null and p_snapshot_id<>r.id then raise exception using errcode='P0001',message='VERSION_CONFLICT'; end if;
  return jsonb_build_object('generationId',r.id,'fetchedAt',r.fetched_at,'publishedAt',r.completed_at,
    'observedFrom',r.observed_min_date,'observedThrough',r.observed_max_date,
    'asOfDate',(now() at time zone 'America/Sao_Paulo')::date,'client',jsonb_build_object('id',c.id,'name',c.name),
    'clientVersion',c.lock_version,'reference',c.external_reference);
end
$function$;

create or replace function api.get_client_sales_products(p_client_id uuid,p_snapshot_id uuid,p_after_sku text default null)
returns jsonb language plpgsql stable security definer set search_path=''
as $function$
declare context jsonb:=private.sales_client_context(p_client_id,p_snapshot_id); products jsonb; next_sku text;
begin
  if p_snapshot_id is null or (p_after_sku is not null and char_length(p_after_sku)>80) then
    raise exception using errcode='P0001',message='VALIDATION_FAILED';
  end if;
  with latest as (
    select distinct on(sku collate "C") sku,product_description,item_group,item_subgroup,category,brand,line
    from private.sales_snapshot_lines where run_id=(context->>'generationId')::uuid
      and sale_date<=(context->>'asOfDate')::date
      and (p_after_sku is null or sku collate "C">p_after_sku collate "C")
    order by sku collate "C",source_row desc limit 1001
  ), page as (select * from latest order by sku collate "C" limit 1000)
  select coalesce(jsonb_agg(jsonb_build_object('sku',sku,'productDescription',product_description,'itemGroup',item_group,
    'itemSubgroup',item_subgroup,'category',category,'brand',brand,'line',line) order by sku collate "C"),'[]'::jsonb),
    case when (select count(*) from latest)>1000 then max(sku collate "C") else null end
  into products,next_sku from page;
  return jsonb_build_object('generationId',context->'generationId','asOfDate',context->'asOfDate',
    'clientVersion',context->'clientVersion','products',products,'nextAfterSku',next_sku);
end
$function$;

create function api.get_sales_route_signals(p_seller_id uuid,p_client_ids uuid[],p_snapshot_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path=''
as $function$
declare
  identity_document jsonb:=private.route_identity('sales.read_client');
  reference_date date:=(now() at time zone 'America/Sao_Paulo')::date;
  month_start date:=date_trunc('month',reference_date)::date;
  history_start date:=(month_start-interval '11 months')::date;
  volume_start date:=(month_start-interval '6 months')::date;
  requested_count integer;
  r private.sales_sync_runs;
  signals jsonb;
begin
  if not (identity_document->'capabilities' ? 'route.plan_scoped') then
    raise exception using errcode='P0001',message='FORBIDDEN';
  end if;
  -- uuid[] normalizes UUID spellings. Refuse invalid batches instead of omitting,
  -- deduplicating or truncating client IDs. Multidimensional arrays are not a list.
  requested_count:=cardinality(p_client_ids);
  if p_seller_id is null or p_client_ids is null or array_ndims(p_client_ids) is distinct from 1
    or requested_count not between 1 and 50
    or exists(select 1 from unnest(p_client_ids) id where id is null)
    or (select count(distinct id) from unnest(p_client_ids) id)<>requested_count then
    raise exception using errcode='P0001',message='VALIDATION_FAILED';
  end if;
  if not (identity_document->'scopeIds' ? p_seller_id::text) or not exists(
    select 1 from api.user_profiles profile where profile.id=p_seller_id
      and profile.status='active' and profile.blocked_at is null) then
    raise exception using errcode='P0001',message='FORBIDDEN';
  end if;
  if (select count(*) from api.clients client where client.id=any(p_client_ids)
      and client.status='active' and client.archived_at is null and exists(
        select 1 from api.client_seller_scopes scope where scope.client_id=client.id
          and scope.seller_id=p_seller_id and scope.revoked_at is null))<>requested_count then
    raise exception using errcode='P0001',message='NOT_FOUND';
  end if;
  select run.* into r from private.sales_sources source
    join private.sales_sync_runs run on run.id=source.published_run_id where run.status='published';
  if not found then raise exception using errcode='P0001',message='SALES_UNAVAILABLE'; end if;
  if p_snapshot_id is not null and p_snapshot_id<>r.id then
    raise exception using errcode='P0001',message='VERSION_CONFLICT';
  end if;

  -- STABLE executes all reads against the calling statement's snapshot. Generation
  -- rows are immutable; left join preserves authorized clients with no purchases.
  -- Sum stays bigint: 100k rows * 1m units can exceed int4, but not JS safe integers.
  with aggregated as (
    select client.id,client.name,
      max(line.sale_date) filter(where line.kind='sale' and line.volume>0) as last_purchase_date,
      count(distinct line.sale_date) filter(where line.kind='sale' and line.volume>0
        and line.sale_date>=history_start) as purchase_day_count,
      coalesce(max(line.sale_date) filter(where line.kind='sale' and line.volume>0 and line.sale_date>=history_start)
        -min(line.sale_date) filter(where line.kind='sale' and line.volume>0 and line.sale_date>=history_start),0) as interval_total_days,
      coalesce(sum(line.volume) filter(where line.sale_date>=volume_start and line.sale_date<month_start),0) as net_volume
    from api.clients client left join private.sales_snapshot_lines line
      on line.run_id=r.id and line.client_external_reference=client.external_reference
        and line.sale_date<=reference_date
    where client.id=any(p_client_ids)
    group by client.id,client.name
  )
  select jsonb_agg(jsonb_build_object('client',jsonb_build_object('id',id,'name',name),
    'lastPurchaseDate',last_purchase_date,'purchaseDayCount12',purchase_day_count,
    'intervalTotalDays12',interval_total_days,'netVolume6',net_volume) order by id)
    into signals from aggregated;
  return jsonb_build_object('generationId',r.id,'fetchedAt',r.fetched_at,'publishedAt',r.completed_at,
    'observedFrom',r.observed_min_date,'observedThrough',r.observed_max_date,'asOfDate',reference_date,
    'sellerId',p_seller_id,'signals',signals);
end
$function$;
comment on function api.get_sales_route_signals(uuid,uuid[],uuid) is
  'Read-only, atomic batch of 1-50 currently eligible clients for one scoped seller. Current sales generation and server Sao Paulo reference date; never mutates or publishes routes.';
revoke all on function api.get_sales_route_signals(uuid,uuid[],uuid) from public,anon,authenticated,service_role;
grant execute on function api.get_sales_route_signals(uuid,uuid[],uuid) to authenticated;
-- CREATE OR REPLACE retains existing owners and ACLs for the context/catalog.
reset role;
revoke create on schema api,private from cirne_route_executor;
do $membership$
begin execute format('revoke cirne_route_executor from %I granted by current_user',current_user); end
$membership$;
commit;
