-- Story 4.18: immutable Google Sheets scrap-ledger generations.
begin;
select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cirne:database:migrate'));
do $membership$ begin execute pg_catalog.format('grant cirne_route_executor to %I with set true granted by current_user',current_user); end $membership$;
grant usage,create on schema api,private to cirne_route_executor;

insert into api.role_permissions(role_id,permission_code)
select id,'scrap_ledger.sync' from api.roles where code in ('manager','administrator') on conflict do nothing;
insert into api.role_permissions(role_id,permission_code)
select id,'scrap_ledger.read' from api.roles where code in ('seller','manager','administrator') on conflict do nothing;

create table private.scrap_ledger_runs(
 id uuid primary key default gen_random_uuid(), request_key text not null unique, trigger text not null check(trigger in('manual','scheduled')),
 status text not null default 'collecting' check(status in('collecting','published','failed')), requested_by uuid not null references auth.users(id),
 started_at timestamptz not null default clock_timestamp(), completed_at timestamptz, content_hash text, entry_count integer not null default 0,
 balance_count integer not null default 0, error_code text, constraint scrap_ledger_hash check(content_hash is null or content_hash~'^[0-9a-f]{64}$')
);
create table private.scrap_ledger_entries(
 generation_id uuid not null references private.scrap_ledger_runs(id), source_row integer not null, sequence text not null, operation text not null check(operation in('debit','credit')),
 client_external_reference text not null, client_name text not null, city text not null, seller text not null, invoice_number text not null, occurred_on date not null,
 source_weight_kg numeric(15,3) not null, price text not null, total text not null, status text not null, settlement_method text not null, duplicate text not null,
 commitment_term text not null, settlement_term text not null, notes text not null, signed_weight_kg numeric(15,3) not null, portfolio_seller text not null, trade_name text not null,
 portfolio_city text not null, group_name text not null, client_status text not null,
 primary key(generation_id,source_row), check(client_external_reference~'^([0-9]{11}|[0-9]{14})$')
);
create index scrap_ledger_entries_client_date on private.scrap_ledger_entries(generation_id,client_external_reference,occurred_on desc);
create table private.scrap_ledger_balances(
 generation_id uuid not null references private.scrap_ledger_runs(id), source_row integer not null, client_external_reference text not null, client_status text not null,
 group_name text not null, legal_name text not null, trade_name text not null, city text not null, portfolio_seller text not null,
 original_debits_kg numeric(15,3) not null, obligation_kg numeric(15,3) not null, credits_kg numeric(15,3) not null, balance_kg numeric(15,3) not null,
 balance_status text not null, pending_since date, overdue_days integer, overdue_band text not null, last_movement_on date, last_debit_on date,
 last_debit_weight_kg numeric(15,3), last_credit_on date, last_credit_weight_kg numeric(15,3), entry_count integer not null,
 primary key(generation_id,source_row), check(client_external_reference~'^([0-9]{11}|[0-9]{14})$')
);
create index scrap_ledger_balances_client on private.scrap_ledger_balances(generation_id,client_external_reference);
create table private.scrap_ledger_head(singleton boolean primary key default true check(singleton),generation_id uuid references private.scrap_ledger_runs(id));
insert into private.scrap_ledger_head(singleton) values(true);

create function private.scrap_ledger_identity(p_permission text) returns jsonb language plpgsql stable security definer set search_path='' as $f$
declare result jsonb;
begin select private.route_identity(p_permission) into result; return result; end$f$;

create function api.begin_scrap_ledger_sync(p_request_key text,p_trigger text) returns jsonb language plpgsql volatile security definer set search_path='' as $f$
declare ident jsonb:=private.scrap_ledger_identity('scrap_ledger.sync');run private.scrap_ledger_runs;local_time timestamp:=clock_timestamp() at time zone 'America/Sao_Paulo';
begin if p_trigger not in('manual','scheduled')then raise exception using errcode='P0001',message='VALIDATION_FAILED';end if;if p_trigger='scheduled'and not((extract(hour from local_time)=8 or extract(hour from local_time)=18)and p_request_key=to_char(local_time,'YYYY-MM-DD@HH24:00'))then raise exception using errcode='P0001',message='VALIDATION_FAILED';end if;select * into run from private.scrap_ledger_runs where request_key=p_request_key;if not found then insert into private.scrap_ledger_runs(request_key,trigger,requested_by)values(p_request_key,p_trigger,(ident->>'id')::uuid)returning * into run;elsif run.requested_by<>(ident->>'id')::uuid then raise exception using errcode='P0001',message='NOT_FOUND';end if;return jsonb_build_object('id',run.id,'status',run.status,'trigger',run.trigger,'startedAt',run.started_at,'completedAt',run.completed_at,'entryCount',run.entry_count,'balanceCount',run.balance_count,'errorCode',run.error_code);end$f$;

create function api.stage_scrap_ledger_entries(p_run_id uuid,p_rows jsonb)returns integer language plpgsql volatile security definer set search_path='' as $f$
declare ident jsonb:=private.scrap_ledger_identity('scrap_ledger.sync');run private.scrap_ledger_runs;e jsonb;
begin select * into run from private.scrap_ledger_runs where id=p_run_id for update;if not found or run.requested_by<>(ident->>'id')::uuid then raise exception using errcode='P0001',message='NOT_FOUND';end if;if run.status<>'collecting'or jsonb_typeof(p_rows)<>'array'or jsonb_array_length(p_rows)not between 1 and 500 then raise exception using errcode='P0001',message='VALIDATION_FAILED';end if;for e in select value from jsonb_array_elements(p_rows)loop insert into private.scrap_ledger_entries values(run.id,(e->>'sourceRow')::integer,e->>'sequence',e->>'operation',e->>'clientExternalReference',e->>'clientName',e->>'city',e->>'seller',e->>'invoiceNumber',(e->>'occurredOn')::date,(e->>'sourceWeightKg')::numeric,e->>'price',e->>'total',e->>'status',e->>'settlementMethod',e->>'duplicate',e->>'commitmentTerm',e->>'settlementTerm',e->>'notes',(e->>'signedWeightKg')::numeric,e->>'portfolioSeller',e->>'tradeName',e->>'portfolioCity',e->>'groupName',e->>'clientStatus')on conflict do nothing;end loop;select count(*)::integer into run.entry_count from private.scrap_ledger_entries where generation_id=run.id;update private.scrap_ledger_runs set entry_count=run.entry_count where id=run.id;return run.entry_count;end$f$;

create function api.stage_scrap_ledger_balances(p_run_id uuid,p_rows jsonb)returns integer language plpgsql volatile security definer set search_path='' as $f$
declare ident jsonb:=private.scrap_ledger_identity('scrap_ledger.sync');run private.scrap_ledger_runs;b jsonb;
begin select * into run from private.scrap_ledger_runs where id=p_run_id for update;if not found or run.requested_by<>(ident->>'id')::uuid then raise exception using errcode='P0001',message='NOT_FOUND';end if;if run.status<>'collecting'or jsonb_typeof(p_rows)<>'array'or jsonb_array_length(p_rows)not between 1 and 500 then raise exception using errcode='P0001',message='VALIDATION_FAILED';end if;for b in select value from jsonb_array_elements(p_rows)loop insert into private.scrap_ledger_balances values(run.id,(b->>'sourceRow')::integer,b->>'clientExternalReference',b->>'clientStatus',b->>'groupName',b->>'legalName',b->>'tradeName',b->>'city',b->>'portfolioSeller',(b->>'originalDebitsKg')::numeric,(b->>'obligationKg')::numeric,(b->>'creditsKg')::numeric,(b->>'balanceKg')::numeric,b->>'balanceStatus',nullif(b->>'pendingSince','')::date,nullif(b->>'overdueDays','')::integer,b->>'overdueBand',nullif(b->>'lastMovementOn','')::date,nullif(b->>'lastDebitOn','')::date,nullif(b->>'lastDebitWeightKg','')::numeric,nullif(b->>'lastCreditOn','')::date,nullif(b->>'lastCreditWeightKg','')::numeric,(b->>'entryCount')::integer)on conflict do nothing;end loop;select count(*)::integer into run.balance_count from private.scrap_ledger_balances where generation_id=run.id;update private.scrap_ledger_runs set balance_count=run.balance_count where id=run.id;return run.balance_count;end$f$;

create function api.publish_staged_scrap_ledger(p_run_id uuid,p_content_hash text,p_entry_count integer,p_balance_count integer)returns jsonb language plpgsql volatile security definer set search_path='' as $f$
declare ident jsonb:=private.scrap_ledger_identity('scrap_ledger.sync');run private.scrap_ledger_runs;
begin select * into run from private.scrap_ledger_runs where id=p_run_id for update;if not found or run.requested_by<>(ident->>'id')::uuid then raise exception using errcode='P0001',message='NOT_FOUND';end if;if run.status='published'then return jsonb_build_object('id',run.id,'status',run.status,'trigger',run.trigger,'startedAt',run.started_at,'completedAt',run.completed_at,'entryCount',run.entry_count,'balanceCount',run.balance_count,'errorCode',run.error_code);end if;if run.status<>'collecting' or p_entry_count is null or p_entry_count<1 or p_balance_count is null or p_balance_count<1 or p_content_hash!~'^[0-9a-f]{64}$'or p_entry_count<>(select count(*)from private.scrap_ledger_entries where generation_id=run.id)or p_balance_count<>(select count(*)from private.scrap_ledger_balances where generation_id=run.id)then raise exception using errcode='P0001',message='VERSION_CONFLICT';end if;update private.scrap_ledger_runs set status='published',completed_at=clock_timestamp(),content_hash=p_content_hash,entry_count=p_entry_count,balance_count=p_balance_count where id=run.id returning * into run;update private.scrap_ledger_head set generation_id=run.id where singleton;return jsonb_build_object('id',run.id,'status',run.status,'trigger',run.trigger,'startedAt',run.started_at,'completedAt',run.completed_at,'entryCount',run.entry_count,'balanceCount',run.balance_count,'errorCode',run.error_code);end$f$;

create function api.fail_scrap_ledger_sync(p_run_id uuid,p_error_code text)returns jsonb language plpgsql volatile security definer set search_path='' as $f$
declare ident jsonb:=private.scrap_ledger_identity('scrap_ledger.sync');run private.scrap_ledger_runs;
begin if p_error_code!~'^[A-Z0-9_]{3,64}$' then raise exception using errcode='P0001',message='VALIDATION_FAILED';end if;select * into run from private.scrap_ledger_runs where id=p_run_id for update;if not found or run.requested_by<>(ident->>'id')::uuid then raise exception using errcode='P0001',message='NOT_FOUND';end if;if run.status='collecting' then update private.scrap_ledger_runs set status='failed',completed_at=clock_timestamp(),error_code=p_error_code where id=run.id returning * into run;end if;return jsonb_build_object('id',run.id,'status',run.status,'trigger',run.trigger,'startedAt',run.started_at,'completedAt',run.completed_at,'entryCount',run.entry_count,'balanceCount',run.balance_count,'errorCode',run.error_code);end$f$;

create function api.publish_scrap_ledger_snapshot(p_request_key text,p_trigger text,p_entries jsonb,p_balances jsonb,p_content_hash text)
returns jsonb language plpgsql volatile security definer set search_path='' as $f$
declare ident jsonb:=private.scrap_ledger_identity('scrap_ledger.sync'); run private.scrap_ledger_runs; e jsonb; b jsonb; local_time timestamp:=clock_timestamp() at time zone 'America/Sao_Paulo';
begin
 if p_trigger not in('manual','scheduled') or p_content_hash!~'^[0-9a-f]{64}$' or jsonb_typeof(p_entries)<>'array' or jsonb_typeof(p_balances)<>'array'
  or jsonb_array_length(p_entries) not between 1 and 30000 or jsonb_array_length(p_balances) not between 1 and 10000 then raise exception using errcode='P0001',message='VALIDATION_FAILED'; end if;
 if p_trigger='scheduled' and not((extract(hour from local_time)=8 or extract(hour from local_time)=18) and p_request_key=to_char(local_time,'YYYY-MM-DD@HH24:00')) then raise exception using errcode='P0001',message='VALIDATION_FAILED'; end if;
 select * into run from private.scrap_ledger_runs where request_key=p_request_key;
 if found then if run.requested_by<>(ident->>'id')::uuid then raise exception using errcode='P0001',message='NOT_FOUND'; end if; return jsonb_build_object('id',run.id,'status',run.status,'trigger',run.trigger,'startedAt',run.started_at,'completedAt',run.completed_at,'entryCount',run.entry_count,'balanceCount',run.balance_count,'errorCode',run.error_code); end if;
 insert into private.scrap_ledger_runs(request_key,trigger,requested_by) values(p_request_key,p_trigger,(ident->>'id')::uuid) returning * into run;
 for e in select value from jsonb_array_elements(p_entries) loop
  insert into private.scrap_ledger_entries values(run.id,(e->>'sourceRow')::integer,e->>'sequence',e->>'operation',e->>'clientExternalReference',e->>'clientName',e->>'city',e->>'seller',e->>'invoiceNumber',(e->>'occurredOn')::date,(e->>'sourceWeightKg')::numeric,e->>'price',e->>'total',e->>'status',e->>'settlementMethod',e->>'duplicate',e->>'commitmentTerm',e->>'settlementTerm',e->>'notes',(e->>'signedWeightKg')::numeric,e->>'portfolioSeller',e->>'tradeName',e->>'portfolioCity',e->>'groupName',e->>'clientStatus');
 end loop;
 for b in select value from jsonb_array_elements(p_balances) loop
  insert into private.scrap_ledger_balances values(run.id,(b->>'sourceRow')::integer,b->>'clientExternalReference',b->>'clientStatus',b->>'groupName',b->>'legalName',b->>'tradeName',b->>'city',b->>'portfolioSeller',(b->>'originalDebitsKg')::numeric,(b->>'obligationKg')::numeric,(b->>'creditsKg')::numeric,(b->>'balanceKg')::numeric,b->>'balanceStatus',nullif(b->>'pendingSince','')::date,nullif(b->>'overdueDays','')::integer,b->>'overdueBand',nullif(b->>'lastMovementOn','')::date,nullif(b->>'lastDebitOn','')::date,nullif(b->>'lastDebitWeightKg','')::numeric,nullif(b->>'lastCreditOn','')::date,nullif(b->>'lastCreditWeightKg','')::numeric,(b->>'entryCount')::integer);
 end loop;
 update private.scrap_ledger_runs set status='published',completed_at=clock_timestamp(),content_hash=p_content_hash,entry_count=jsonb_array_length(p_entries),balance_count=jsonb_array_length(p_balances) where id=run.id returning * into run;
 update private.scrap_ledger_head set generation_id=run.id where singleton;
 return jsonb_build_object('id',run.id,'status',run.status,'trigger',run.trigger,'startedAt',run.started_at,'completedAt',run.completed_at,'entryCount',run.entry_count,'balanceCount',run.balance_count,'errorCode',run.error_code);
exception when others then if run.id is not null then update private.scrap_ledger_runs set status='failed',completed_at=clock_timestamp(),error_code='PERSISTENCE_FAILED' where id=run.id; end if; raise; end$f$;

create function api.get_scrap_ledger_sync_status() returns jsonb language plpgsql stable security definer set search_path='' as $f$
declare ident jsonb:=private.scrap_ledger_identity('scrap_ledger.sync'); latest private.scrap_ledger_runs; successful timestamptz;
begin select * into latest from private.scrap_ledger_runs order by started_at desc limit 1;select max(completed_at) into successful from private.scrap_ledger_runs where status='published';return jsonb_build_object('latestRun',case when latest.id is null then null else jsonb_build_object('id',latest.id,'status',latest.status,'trigger',latest.trigger,'startedAt',latest.started_at,'completedAt',latest.completed_at,'entryCount',latest.entry_count,'balanceCount',latest.balance_count,'errorCode',latest.error_code)end,'lastSuccessAt',successful);end$f$;

create function private.scrap_client_allowed(p_client_id uuid) returns api.clients language plpgsql stable security definer set search_path='' as $f$
declare ident jsonb:=private.scrap_ledger_identity('scrap_ledger.read'); c api.clients;
begin select * into c from api.clients x where x.id=p_client_id and exists(select 1 from api.client_seller_scopes s where s.client_id=x.id and s.revoked_at is null and ident->'scopeIds'?s.seller_id::text);if not found then raise exception using errcode='P0001',message='NOT_FOUND';end if;return c;end$f$;

create function api.get_client_scrap_summary(p_client_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $f$
declare c api.clients:=private.scrap_client_allowed(p_client_id); gen uuid; published timestamptz; bal private.scrap_ledger_balances; credits numeric; debits numeric; recent numeric; previous numeric; trend text;
begin select h.generation_id,r.completed_at into gen,published from private.scrap_ledger_head h join private.scrap_ledger_runs r on r.id=h.generation_id where h.singleton;if gen is null then raise exception using errcode='P0001',message='NOT_FOUND';end if;
 select * into bal from private.scrap_ledger_balances where generation_id=gen and client_external_reference=c.external_reference order by source_row limit 1;if not found then raise exception using errcode='P0001',message='NOT_FOUND';end if;
 select coalesce(sum(signed_weight_kg)filter(where operation='credit' and occurred_on>=current_date-interval '12 months'),0)/12,coalesce(-sum(signed_weight_kg)filter(where operation='debit' and occurred_on>=current_date-interval '12 months'),0)/12,
 coalesce(-sum(signed_weight_kg)filter(where occurred_on>=date_trunc('month',current_date)-interval '2 months'),0)/3,
 coalesce(-sum(signed_weight_kg)filter(where occurred_on>=date_trunc('month',current_date)-interval '5 months' and occurred_on<date_trunc('month',current_date)-interval '2 months'),0)/3
 into credits,debits,recent,previous from private.scrap_ledger_entries where generation_id=gen and client_external_reference=c.external_reference;
 trend:=case when recent>previous then 'growing' when recent<previous then 'falling' else 'stable' end;
 return jsonb_build_object('generationId',gen,'publishedAt',published,'client',jsonb_build_object('id',c.id,'name',c.name),'currentDebtKg',to_char(greatest(0,-bal.balance_kg),'FM999999999990.000'),'balanceKg',to_char(bal.balance_kg,'FM999999999990.000'),'balanceStatus',bal.balance_status,'lastCollectionOn',bal.last_credit_on,'lastCollectionKg',case when bal.last_credit_weight_kg is null then null else to_char(bal.last_credit_weight_kg,'FM999999999990.000')end,'averageMonthlyCredits12mKg',to_char(credits,'FM999999999990.000'),'averageMonthlyDebits12mKg',to_char(debits,'FM999999999990.000'),'trend',trend,'trendMethod','recent_3m_vs_previous_3m_net_debt');end$f$;

create function api.get_scrap_ledger_analytics(p_view text,p_search text default '',p_page integer default 1) returns jsonb language plpgsql stable security definer set search_path='' as $f$
declare ident jsonb:=private.scrap_ledger_identity('scrap_ledger.sync');gen uuid;rows jsonb;total integer;
begin if p_view not in('entries','balances')or p_page not between 1 and 10000 or char_length(p_search)>120 then raise exception using errcode='P0001',message='VALIDATION_FAILED';end if;select generation_id into gen from private.scrap_ledger_head where singleton;
 if p_view='entries' then select count(*)into total from private.scrap_ledger_entries where generation_id=gen and(client_name ilike '%'||p_search||'%'or client_external_reference like '%'||regexp_replace(p_search,'\D','','g')||'%');select coalesce(jsonb_agg(to_jsonb(x)order by x.occurred_on desc,x.source_row desc),'[]')into rows from(select * from private.scrap_ledger_entries where generation_id=gen and(client_name ilike '%'||p_search||'%'or client_external_reference like '%'||regexp_replace(p_search,'\D','','g')||'%')order by occurred_on desc,source_row desc limit 50 offset(p_page-1)*50)x;
 else select count(*)into total from private.scrap_ledger_balances where generation_id=gen and(legal_name ilike '%'||p_search||'%'or trade_name ilike '%'||p_search||'%'or client_external_reference like '%'||regexp_replace(p_search,'\D','','g')||'%');select coalesce(jsonb_agg(to_jsonb(x)||jsonb_build_object('trend',case when recent_net>previous_net then 'growing' when recent_net<previous_net then 'falling' else 'stable'end)order by x.balance_kg,x.source_row),'[]')into rows from(select b.*,
   coalesce((select -sum(e.signed_weight_kg)/3 from private.scrap_ledger_entries e where e.generation_id=gen and e.client_external_reference=b.client_external_reference and e.occurred_on>=date_trunc('month',current_date)-interval '2 months'),0)recent_net,
   coalesce((select -sum(e.signed_weight_kg)/3 from private.scrap_ledger_entries e where e.generation_id=gen and e.client_external_reference=b.client_external_reference and e.occurred_on>=date_trunc('month',current_date)-interval '5 months' and e.occurred_on<date_trunc('month',current_date)-interval '2 months'),0)previous_net
   from private.scrap_ledger_balances b where generation_id=gen and(legal_name ilike '%'||p_search||'%'or trade_name ilike '%'||p_search||'%'or client_external_reference like '%'||regexp_replace(p_search,'\D','','g')||'%')order by balance_kg,source_row limit 50 offset(p_page-1)*50)x;end if;
 return jsonb_build_object('generationId',gen,'view',p_view,'page',p_page,'pageSize',50,'totalCount',total,'rows',rows,'trendMethod','recent_3m_vs_previous_3m_net_debt');end$f$;

grant select,insert,update on private.scrap_ledger_runs,private.scrap_ledger_entries,private.scrap_ledger_balances,private.scrap_ledger_head to cirne_route_executor;
do $g$ declare r record;begin for r in select p.oid::regprocedure signature,n.nspname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.proname in('scrap_ledger_identity','scrap_client_allowed','begin_scrap_ledger_sync','stage_scrap_ledger_entries','stage_scrap_ledger_balances','publish_staged_scrap_ledger','fail_scrap_ledger_sync','publish_scrap_ledger_snapshot','get_scrap_ledger_sync_status','get_client_scrap_summary','get_scrap_ledger_analytics')loop execute format('alter function %s owner to cirne_route_executor',r.signature);execute format('revoke all on function %s from public,anon,authenticated,service_role',r.signature);if r.nspname='api'then execute format('grant execute on function %s to authenticated',r.signature);end if;end loop;end$g$;
revoke create on schema api,private from cirne_route_executor;
do $membership$ begin execute pg_catalog.format('revoke cirne_route_executor from %I granted by current_user',current_user); end $membership$;
commit;
