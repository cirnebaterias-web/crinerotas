begin;

do $membership$
begin execute format('grant cirne_route_executor to %I with set true granted by current_user',current_user); end
$membership$;
grant usage,create on schema api to cirne_route_executor;
set local role cirne_route_executor;

create or replace function api.get_sales_route_signals(p_seller_id uuid,p_client_ids uuid[],p_snapshot_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path=''
as $function$
declare
  identity_document jsonb:=private.route_identity('sales.read_client');
  reference_date date:=(now() at time zone 'America/Sao_Paulo')::date;
  month_start date:=date_trunc('month',reference_date)::date;
  history_start date:=(month_start-interval '11 months')::date;
  volume_start date:=(month_start-interval '6 months')::date;
  recent_start date:=(month_start-interval '3 months')::date;
  requested_count integer;
  r private.sales_sync_runs;
  signals jsonb;
begin
  if not (identity_document->'capabilities' ? 'route.plan_scoped') then
    raise exception using errcode='P0001',message='FORBIDDEN';
  end if;
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

  with classified as materialized (
    select line.*,
      case
        when lower(concat_ws(' ',line.item_group,line.item_subgroup,line.category,line.line,line.product_description)) ~ '\y(moto|motocicleta)' then 'motorcycle'
        when lower(concat_ws(' ',line.item_group,line.item_subgroup,line.category,line.line,line.product_description)) ~ '(pesad|caminh|onibus|ônibus|trator)' then 'heavy'
        when lower(concat_ws(' ',line.item_group,line.item_subgroup,line.category,line.line,line.product_description)) like '%segunda linha%' then 'second_line'
        when lower(concat_ws(' ',line.item_group,line.item_subgroup,line.category,line.line,line.product_description)) like '%primeira linha%' then 'first_line'
        else null
      end as segment
    from private.sales_snapshot_lines line where line.run_id=r.id and line.sale_date<=reference_date
  ), aggregated as (
    select client.id,client.name,client.external_reference,
      max(line.sale_date) filter(where line.kind='sale' and line.volume>0) as last_purchase_date,
      count(distinct line.sale_date) filter(where line.kind='sale' and line.volume>0
        and line.sale_date>=history_start) as purchase_day_count,
      coalesce(max(line.sale_date) filter(where line.kind='sale' and line.volume>0 and line.sale_date>=history_start)
        -min(line.sale_date) filter(where line.kind='sale' and line.volume>0 and line.sale_date>=history_start),0) as interval_total_days,
      coalesce(sum(line.volume) filter(where line.sale_date>=volume_start and line.sale_date<month_start),0) as net_volume,
      coalesce(sum(line.volume) filter(where line.sale_date>=recent_start and line.sale_date<month_start),0) as recent_volume,
      coalesce(sum(line.volume) filter(where line.sale_date>=volume_start and line.sale_date<recent_start),0) as previous_volume
    from api.clients client left join classified line
      on line.client_external_reference=client.external_reference
    where client.id=any(p_client_ids)
    group by client.id,client.name,client.external_reference
  )
  select jsonb_agg(jsonb_build_object('client',jsonb_build_object('id',item.id,'name',item.name),
    'lastPurchaseDate',item.last_purchase_date,'purchaseDayCount12',item.purchase_day_count,
    'intervalTotalDays12',item.interval_total_days,'netVolume6',item.net_volume,
    'recentVolume3',item.recent_volume,'previousVolume3',item.previous_volume,
    'opportunitySegments',coalesce((select jsonb_agg(segment order by segment) from (
      select distinct universe.segment from classified universe where universe.segment is not null
        and not exists(select 1 from classified owned where owned.client_external_reference=item.external_reference
          and owned.segment=universe.segment and owned.kind='sale' and owned.volume>0)) missing),'[]'::jsonb)) order by item.id)
    into signals from aggregated item;
  return jsonb_build_object('generationId',r.id,'fetchedAt',r.fetched_at,'publishedAt',r.completed_at,
    'observedFrom',r.observed_min_date,'observedThrough',r.observed_max_date,'asOfDate',reference_date,
    'sellerId',p_seller_id,'signals',signals);
end
$function$;

comment on function api.get_sales_route_signals(uuid,uuid[],uuid) is
  'Atomic scoped commercial route signals with purchase cadence, recent trend and observed segment opportunities; read-only and never publishes routes.';

reset role;
commit;
