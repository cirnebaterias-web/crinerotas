-- Story 4.18 follow-up: constrain analytics search to trade name, tax id, or legal name.
begin;
select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cirne:database:migrate'));
do $membership$ begin execute pg_catalog.format('grant cirne_route_executor to %I with set true granted by current_user',current_user); end $membership$;
grant usage,create on schema api,private to cirne_route_executor;
set local role cirne_route_executor;

create function private.scrap_ledger_document_allowed(p_identity jsonb,p_document text) returns boolean
language sql stable security definer set search_path='' as $f$
 select coalesce(p_identity->'roles' ? 'administrator' or exists(
  select 1 from api.clients c join api.client_seller_scopes scope on scope.client_id=c.id and scope.revoked_at is null
  where c.external_reference=p_document and c.archived_at is null and p_identity->'scopeIds' ? scope.seller_id::text
 ),false)
$f$;

create or replace function api.get_scrap_ledger_analytics(p_view text,p_search text default '',p_page integer default 1) returns jsonb
language plpgsql stable security definer set search_path='' as $f$
declare ident jsonb:=private.scrap_ledger_identity('scrap_ledger.sync');gen uuid;rows jsonb;total integer;totals jsonb;digits text:=regexp_replace(p_search,'\D','','g');
begin
 if p_view not in('entries','balances')or p_page not between 1 and 10000 or char_length(p_search)>120 then raise exception using errcode='P0001',message='VALIDATION_FAILED';end if;
 select generation_id into gen from private.scrap_ledger_head where singleton;
 if p_view='entries' then
  select count(*) into total from private.scrap_ledger_entries e
   where e.generation_id=gen and private.scrap_ledger_document_allowed(ident,e.client_external_reference)
    and (p_search='' or e.trade_name ilike '%'||p_search||'%' or (digits<>'' and e.client_external_reference like '%'||digits||'%') or exists(
     select 1 from private.scrap_ledger_balances b where b.generation_id=gen and b.client_external_reference=e.client_external_reference
      and (b.legal_name ilike '%'||p_search||'%' or b.trade_name ilike '%'||p_search||'%')));
  select coalesce(jsonb_agg(to_jsonb(x) order by x.occurred_on desc,x.source_row desc),'[]') into rows from(
   select e.* from private.scrap_ledger_entries e where e.generation_id=gen
    and private.scrap_ledger_document_allowed(ident,e.client_external_reference)
    and (p_search='' or e.trade_name ilike '%'||p_search||'%' or (digits<>'' and e.client_external_reference like '%'||digits||'%') or exists(
     select 1 from private.scrap_ledger_balances b where b.generation_id=gen and b.client_external_reference=e.client_external_reference
      and (b.legal_name ilike '%'||p_search||'%' or b.trade_name ilike '%'||p_search||'%')))
   order by e.occurred_on desc,e.source_row desc limit 50 offset(p_page-1)*50)x;
  select jsonb_build_object(
   'source_weight_kg',to_char(coalesce(sum(e.source_weight_kg),0),'FM999999999990.000'),
   'signed_weight_kg',to_char(coalesce(sum(e.signed_weight_kg),0),'FM999999999990.000')) into totals
  from private.scrap_ledger_entries e where e.generation_id=gen
   and private.scrap_ledger_document_allowed(ident,e.client_external_reference)
   and (p_search='' or e.trade_name ilike '%'||p_search||'%' or (digits<>'' and e.client_external_reference like '%'||digits||'%') or exists(
    select 1 from private.scrap_ledger_balances b where b.generation_id=gen and b.client_external_reference=e.client_external_reference
     and (b.legal_name ilike '%'||p_search||'%' or b.trade_name ilike '%'||p_search||'%')));
 else
  select count(*) into total from private.scrap_ledger_balances b where b.generation_id=gen
   and private.scrap_ledger_document_allowed(ident,b.client_external_reference)
   and (b.legal_name ilike '%'||p_search||'%' or b.trade_name ilike '%'||p_search||'%' or (digits<>'' and b.client_external_reference like '%'||digits||'%'));
  select coalesce(jsonb_agg(to_jsonb(x)||jsonb_build_object('trend',case when recent_net>previous_net then 'growing' when recent_net<previous_net then 'falling' else 'stable'end) order by x.balance_kg,x.source_row),'[]') into rows from(
   select b.*,
    coalesce((select -sum(e.signed_weight_kg)/3 from private.scrap_ledger_entries e where e.generation_id=gen and e.client_external_reference=b.client_external_reference and e.occurred_on>=date_trunc('month',current_date)-interval '2 months'),0)recent_net,
    coalesce((select -sum(e.signed_weight_kg)/3 from private.scrap_ledger_entries e where e.generation_id=gen and e.client_external_reference=b.client_external_reference and e.occurred_on>=date_trunc('month',current_date)-interval '5 months' and e.occurred_on<date_trunc('month',current_date)-interval '2 months'),0)previous_net
   from private.scrap_ledger_balances b where b.generation_id=gen
    and private.scrap_ledger_document_allowed(ident,b.client_external_reference)
    and (b.legal_name ilike '%'||p_search||'%' or b.trade_name ilike '%'||p_search||'%' or (digits<>'' and b.client_external_reference like '%'||digits||'%'))
   order by b.balance_kg,b.source_row limit 50 offset(p_page-1)*50)x;
  select jsonb_build_object(
   'original_debits_kg',to_char(coalesce(sum(b.original_debits_kg),0),'FM999999999990.000'),
   'obligation_kg',to_char(coalesce(sum(b.obligation_kg),0),'FM999999999990.000'),
   'credits_kg',to_char(coalesce(sum(b.credits_kg),0),'FM999999999990.000'),
   'balance_kg',to_char(coalesce(sum(b.balance_kg),0),'FM999999999990.000'),
   'last_credit_weight_kg',to_char(coalesce(sum(b.last_credit_weight_kg),0),'FM999999999990.000')) into totals
  from private.scrap_ledger_balances b where b.generation_id=gen
   and private.scrap_ledger_document_allowed(ident,b.client_external_reference)
   and (b.legal_name ilike '%'||p_search||'%' or b.trade_name ilike '%'||p_search||'%' or (digits<>'' and b.client_external_reference like '%'||digits||'%'));
 end if;
 return jsonb_build_object('generationId',gen,'view',p_view,'page',p_page,'pageSize',50,'totalCount',total,'rows',rows,'totals',totals,'trendMethod','recent_3m_vs_previous_3m_net_debt');
end$f$;

revoke all on function private.scrap_ledger_document_allowed(jsonb,text) from public,anon,authenticated,service_role;

reset role;
revoke create on schema api,private from cirne_route_executor;
do $membership$ begin execute pg_catalog.format('revoke cirne_route_executor from %I granted by current_user',current_user); end $membership$;
commit;
