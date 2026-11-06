-- Story 4.13 / AC7: diagnose existing clients without a current portfolio link.
-- Additive diagnostic change only; preserve facts, old generations and replays.
begin;
select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cirne:database:migrate'));
set local lock_timeout='5s';
do $membership$
begin execute format('grant cirne_route_executor to %I with set true granted by current_user',current_user); end
$membership$;
grant usage,create on schema api,private to cirne_route_executor;
set local role cirne_route_executor;
alter table private.sales_sync_issues drop constraint sales_sync_issues_code_check;
alter table private.sales_sync_issues add constraint sales_sync_issues_code_check
  check(code in ('CLIENT_NOT_FOUND','CLIENT_WITHOUT_ACTIVE_SCOPE'));

create or replace function api.publish_sales_sheet_sync(p_run_id uuid,p_lease_token uuid,p_content_hash text,p_expected_row_count integer,p_parser_version integer,p_origin text default 'cli')
returns jsonb language plpgsql volatile security definer set search_path=''
as $function$
declare r private.sales_sync_runs:=private.sales_locked_run(p_run_id,p_lease_token); actual_hash text;
  actual_count integer; chunk_count integer; last_chunk integer; min_date date; max_date date; unmatched integer;
begin
  if p_content_hash is null or p_content_hash !~ '^[0-9a-f]{64}$' or p_expected_row_count is null or p_expected_row_count not between 1 and 100000
    or p_parser_version is distinct from 1 or p_origin is null or p_origin not in ('cli','web','system') then
    raise exception using errcode='P0001',message='VALIDATION_FAILED';
  end if;
  if r.status='published' then
    if r.content_hash<>p_content_hash or r.source_row_count<>p_expected_row_count or r.parser_version<>p_parser_version then
      raise exception using errcode='P0001',message='VERSION_CONFLICT';
    end if;
    return private.sales_sync_document(r.id);
  elsif r.status='failed' then return private.sales_sync_document(r.id);
  end if;
  select count(*)::integer,min(sale_date),max(sale_date),
    encode(extensions.digest(convert_to(string_agg(row_hash,'' order by source_row),'UTF8'),'sha256'),'hex')
    into actual_count,min_date,max_date,actual_hash from private.sales_snapshot_lines where run_id=r.id;
  select count(*)::integer,max(chunk_index) into chunk_count,last_chunk from private.sales_sync_chunks where run_id=r.id;
  if actual_count<>p_expected_row_count or actual_count<>r.staged_row_count or actual_hash is distinct from p_content_hash
    or chunk_count=0 or last_chunk<>chunk_count-1
    or (select sum(row_count) from private.sales_sync_chunks where run_id=r.id)<>actual_count then
    raise exception using errcode='P0001',message='VERSION_CONFLICT';
  end if;
  -- Evaluate distinct documents once. An active link in ANY portfolio is valid
  -- for this diagnostic, even outside the technical importer's scope. Neither
  -- client/seller status nor historical salesperson introduces a new criterion.
  with references_in_run as (
    select distinct client_external_reference from private.sales_snapshot_lines where run_id=r.id
  ), classified as materialized (
    select ref.client_external_reference,
      case when client.id is null then 'CLIENT_NOT_FOUND'
        when not exists(select 1 from api.client_seller_scopes scope
          where scope.client_id=client.id and scope.revoked_at is null)
          then 'CLIENT_WITHOUT_ACTIVE_SCOPE' else null end as code
    from references_in_run ref left join api.clients client on client.external_reference=ref.client_external_reference
  )
  insert into private.sales_sync_issues(run_id,source_row,code)
    select r.id,line.source_row,classified.code from private.sales_snapshot_lines line
    join classified on classified.client_external_reference=line.client_external_reference
    where line.run_id=r.id and classified.code is not null;
  -- Keep the existing DTO meaning: only documents absent from api.clients.
  select count(distinct line.client_external_reference)::integer into unmatched
    from private.sales_snapshot_lines line join private.sales_sync_issues issue
      on issue.run_id=line.run_id and issue.source_row=line.source_row
    where line.run_id=r.id and issue.code='CLIENT_NOT_FOUND';
  update private.sales_sync_runs set status='published',content_hash=actual_hash,parser_version=p_parser_version,source_row_count=actual_count,
    unmatched_client_count=unmatched,issue_count=(select count(*) from private.sales_sync_issues where run_id=r.id),
    observed_min_date=min_date,observed_max_date=max_date,completed_at=clock_timestamp(),updated_at=clock_timestamp() where id=r.id;
  update private.sales_sources set published_run_id=r.id,updated_at=clock_timestamp() where source_key=r.source_key;
  insert into private.audit_events(actor_id,target_type,target_id,action,after_data,origin,request_id)
    values(r.requested_by,'sales_sync',r.id,'sales.published',jsonb_build_object('rowCount',actual_count,'contentHash',actual_hash,'parserVersion',p_parser_version),p_origin,r.id);
  return private.sales_sync_document(r.id);
end
$function$;
comment on table private.sales_sync_issues is
  'Private row/code diagnostics as observed at publication: unknown document or existing client without any unrevoked portfolio link. Never assign clients or recalculate historical generation diagnostics.';
reset role;
revoke create on schema api,private from cirne_route_executor;
do $membership$
begin execute format('revoke cirne_route_executor from %I granted by current_user',current_user); end
$membership$;
commit;
