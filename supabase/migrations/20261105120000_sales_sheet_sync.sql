-- Stories 4.13 / 4.14, ADR 006. Empty-by-default sales integration.
-- Operational rollback: disable its timer/feature flag; retain immutable generations.
begin;
select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cirne:database:migrate'));
set local lock_timeout = '5s';
do $membership$
begin
  execute pg_catalog.format('grant cirne_route_executor to %I with set true granted by current_user',current_user);
end
$membership$;
grant usage,create on schema api,private to cirne_route_executor;

insert into api.role_permissions(role_id,permission_code)
select id,'sales.sync' from api.roles where code in ('manager','administrator')
on conflict do nothing;
insert into api.role_permissions(role_id,permission_code)
select id,'sales.read_client' from api.roles where code in ('seller','manager')
on conflict do nothing;

-- Administrative configuration is deliberately NOT owned by the RPC executor.
-- Column grants permit only publishing the head, never provisioning a source/actor.
create table private.sales_sources (
  source_key text primary key check(source_key ~ '^[0-9a-f]{64}$'),
  singleton boolean not null default true unique check(singleton),
  scheduler_actor_id uuid references api.user_profiles(id) on delete restrict,
  published_run_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
create index sales_sources_actor_idx on private.sales_sources(scheduler_actor_id);
create index sales_sources_head_idx on private.sales_sources(published_run_id);
alter table private.sales_sources enable row level security;
alter table private.sales_sources force row level security;
revoke all on private.sales_sources from public,anon,authenticated,service_role;
grant select on private.sales_sources to cirne_route_executor;
grant update(published_run_id,updated_at) on private.sales_sources to cirne_route_executor;
create policy sales_sources_read on private.sales_sources for select to cirne_route_executor using(true);
create policy sales_sources_publish on private.sales_sources for update to cirne_route_executor using(true) with check(true);
comment on table private.sales_sources is 'One private Vendas source; DB administration alone provisions its technical actor. NULL actor revokes import without deleting source or generations. No public auto-registration. Executor writes only the published head.';

create table private.sales_sync_runs (
  id uuid primary key default gen_random_uuid(),
  source_key text not null references private.sales_sources(source_key) on delete restrict,
  request_key text not null check(char_length(request_key) between 1 and 100),
  trigger text not null check(trigger in ('manual','scheduled')),
  requested_by uuid not null references api.user_profiles(id) on delete restrict,
  lease_token uuid not null default gen_random_uuid(),
  lease_expires_at timestamptz not null,
  status text not null default 'collecting' check(status in ('collecting','published','failed')),
  content_hash text check(content_hash ~ '^[0-9a-f]{64}$'),
  parser_version integer check(parser_version=1),
  source_row_count integer not null default 0 check(source_row_count between 0 and 100000),
  staged_row_count integer not null default 0 check(staged_row_count between 0 and 100000),
  unmatched_client_count integer not null default 0 check(unmatched_client_count between 0 and 100000),
  issue_count integer not null default 0 check(issue_count between 0 and 100000),
  observed_min_date date,
  observed_max_date date,
  fetched_at timestamptz,
  error_code text check(error_code ~ '^[A-Z][A-Z0-9_]{0,79}$'),
  started_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique(source_key,request_key),
  check((status='collecting')=(completed_at is null)),
  check(status<>'published' or (source_row_count>0 and source_row_count=staged_row_count and content_hash is not null and parser_version is not null))
);
alter table private.sales_sources add constraint sales_sources_head_fk
  foreign key(published_run_id) references private.sales_sync_runs(id) on delete restrict;
create unique index sales_sync_active_source_idx on private.sales_sync_runs(source_key) where status='collecting';
create index sales_sync_latest_idx on private.sales_sync_runs(source_key,started_at desc,id desc);
create index sales_sync_actor_idx on private.sales_sync_runs(requested_by);

create table private.sales_sync_chunks (
  run_id uuid not null references private.sales_sync_runs(id) on delete restrict,
  chunk_index integer not null check(chunk_index between 0 and 99999),
  chunk_hash text not null check(chunk_hash ~ '^[0-9a-f]{64}$'),
  row_count integer not null check(row_count between 1 and 1000),
  created_at timestamptz not null default clock_timestamp(),
  primary key(run_id,chunk_index)
);
create table private.sales_snapshot_lines (
  run_id uuid not null references private.sales_sync_runs(id) on delete restrict,
  source_row integer not null check(source_row between 2 and 100001),
  external_key text not null check(char_length(external_key) between 1 and 256),
  client_external_reference text not null check(client_external_reference ~ '^([0-9]{11}|[0-9]{14})$'),
  invoice_number text not null check(char_length(invoice_number)<=80),
  sale_date date not null,
  sku text not null check(char_length(sku) between 1 and 80),
  product_description text not null check(char_length(product_description)<=240),
  item_group text not null check(char_length(item_group)<=80),
  item_subgroup text not null check(char_length(item_subgroup)<=80),
  category text not null check(char_length(category)<=80),
  brand text not null check(char_length(brand)<=80),
  line text not null check(char_length(line)<=80),
  kind text not null check(kind in ('sale','return')),
  volume integer not null check(volume between -1000000 and 1000000),
  total_amount numeric(12,2) not null,
  row_hash text not null check(row_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  primary key(run_id,source_row),
  unique(run_id,external_key),
  check((kind='sale' and volume>0 and total_amount>=0) or (kind='return' and volume<0 and total_amount<=0))
);
create index sales_lines_client_page_idx on private.sales_snapshot_lines(run_id,client_external_reference,source_row);
create index sales_lines_product_idx on private.sales_snapshot_lines(run_id,sku,source_row desc);
create table private.sales_sync_issues (
  run_id uuid not null references private.sales_sync_runs(id) on delete restrict,
  source_row integer not null,
  code text not null check(code in ('CLIENT_NOT_FOUND')),
  created_at timestamptz not null default clock_timestamp(),
  primary key(run_id,source_row,code),
  foreign key(run_id,source_row) references private.sales_snapshot_lines(run_id,source_row) on delete restrict
);
comment on table private.sales_snapshot_lines is 'Immutable normalized whitelist; no raw sheet JSON, costs, seller names, or source URL. Current client reference/seller scopes authorize reads, never a historical salesperson.';
comment on table private.sales_sync_issues is 'Private row/code diagnostics only; no copied cell or customer identifier in messages.';

do $tables$
declare table_name text;
begin
  foreach table_name in array array['sales_sync_runs','sales_sync_chunks','sales_snapshot_lines','sales_sync_issues'] loop
    execute format('alter table private.%I enable row level security',table_name);
    execute format('alter table private.%I force row level security',table_name);
    execute format('revoke all on private.%I from public,anon,authenticated,service_role',table_name);
    execute format('alter table private.%I owner to cirne_route_executor',table_name);
    execute format('create policy %I on private.%I for select to cirne_route_executor using(true)',table_name||'_read',table_name);
    execute format('create policy %I on private.%I for insert to cirne_route_executor with check(true)',table_name||'_insert',table_name);
  end loop;
end
$tables$;
create policy sales_runs_update on private.sales_sync_runs for update to cirne_route_executor using(true) with check(true);

create function private.sales_source_identity(p_source_key text)
returns jsonb language plpgsql volatile security definer set search_path=''
as $function$
declare identity_document jsonb:=private.route_identity('sales.sync');
begin
  if p_source_key is null or p_source_key !~ '^[0-9a-f]{64}$' then
    raise exception using errcode='P0001',message='VALIDATION_FAILED';
  end if;
  perform 1 from private.sales_sources where source_key=p_source_key
    and scheduler_actor_id=(identity_document->>'id')::uuid for share;
  if not found then raise exception using errcode='P0001',message='FORBIDDEN'; end if;
  return identity_document;
end
$function$;

create function private.sales_sync_document(p_run_id uuid)
returns jsonb language sql stable security definer set search_path=''
as $function$
 select jsonb_build_object('id',r.id,'sourceKey',r.source_key,
  'status',case when r.status='collecting' and r.lease_expires_at<=now() then 'failed' else r.status end,
  'trigger',r.trigger,'startedAt',r.started_at,
  'completedAt',case when r.status='collecting' and r.lease_expires_at<=now() then r.lease_expires_at else r.completed_at end,
  'generationId',case when r.status='published' then r.id else null end,
  'contentHash',r.content_hash,'parserVersion',r.parser_version,'sourceRowCount',r.source_row_count,
  'stagedRowCount',r.staged_row_count,'unmatchedClientCount',r.unmatched_client_count,'issueCount',r.issue_count,
  'observedMinDate',r.observed_min_date,'observedMaxDate',r.observed_max_date,
  'errorCode',case when r.status='collecting' and r.lease_expires_at<=now() then 'SYNC_LEASE_EXPIRED' else r.error_code end)
 from private.sales_sync_runs r where r.id=p_run_id;
$function$;

create function private.sales_locked_run(p_run_id uuid,p_lease_token uuid)
returns private.sales_sync_runs language plpgsql volatile security definer set search_path=''
as $function$
declare r private.sales_sync_runs; identity_document jsonb:=private.route_identity('sales.sync');
begin
  select * into r from private.sales_sync_runs where id=p_run_id;
  if not found then raise exception using errcode='P0001',message='NOT_FOUND'; end if;
  identity_document:=private.sales_source_identity(r.source_key);
  if r.requested_by<>(identity_document->>'id')::uuid or p_lease_token is null or r.lease_token<>p_lease_token then
    raise exception using errcode='P0001',message='NOT_FOUND';
  end if;
  if not pg_try_advisory_xact_lock(hashtextextended('cirne:sales-sync:'||r.source_key,0)) then
    raise exception using errcode='P0001',message='SYNC_BUSY';
  end if;
  select * into r from private.sales_sync_runs where id=p_run_id for update;
  if r.status='collecting' and r.lease_expires_at<=clock_timestamp() then
    raise exception using errcode='P0001',message='SYNC_LEASE_EXPIRED';
  end if;
  return r;
end
$function$;

-- Canonical JSON tuple is intentionally compact; jsonb array::text adds spaces.
-- All 15 keys are mandatory, no extras/C0 controls, canonical calendar/money strings.
create function private.sales_row_hash(p_row jsonb)
returns text language plpgsql immutable security definer set search_path=''
as $function$
declare
  names text[]:=array['sourceRow','externalKey','clientExternalReference','invoiceNumber','saleDate','sku','productDescription','itemGroup','itemSubgroup','category','brand','line','kind','volume','totalAmount'];
  key_name text; scalar jsonb; compact text:=''; parsed_date date; amount numeric;
begin
  if jsonb_typeof(p_row) is distinct from 'object' or (select count(*) from jsonb_object_keys(p_row))<>15 then
    raise exception using errcode='P0001',message='VALIDATION_FAILED';
  end if;
  foreach key_name in array names loop
    scalar:=p_row->key_name;
    if key_name in ('sourceRow','volume') then
      if jsonb_typeof(scalar) is distinct from 'number' or scalar::text !~ '^-?[0-9]+$' then
        raise exception using errcode='P0001',message='VALIDATION_FAILED';
      end if;
    elsif jsonb_typeof(scalar) is distinct from 'string'
      or (p_row->>key_name) ~ '[\x01-\x1f\x7f]'
      or (p_row->>key_name)<>regexp_replace(p_row->>key_name,'^\s+|\s+$','','g')
      or (p_row->>key_name) ~ '^[=+@]' then
      raise exception using errcode='P0001',message='VALIDATION_FAILED';
    end if;
    compact:=compact||case when compact='' then '' else ',' end||scalar::text;
  end loop;
  if (p_row->>'sourceRow')::numeric not between 2 and 100001
    or abs((p_row->>'volume')::numeric)>1000000
    or char_length(btrim(p_row->>'externalKey')) not between 1 and 256
    or (p_row->>'clientExternalReference') !~ '^([0-9]{11}|[0-9]{14})$'
    or char_length(p_row->>'invoiceNumber') not between 1 and 80
    or (p_row->>'saleDate') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    or char_length(btrim(p_row->>'sku')) not between 1 and 80
    or char_length(p_row->>'productDescription') not between 1 and 240
    or char_length(p_row->>'itemGroup')<1
    or greatest(char_length(p_row->>'itemGroup'),char_length(p_row->>'itemSubgroup'),char_length(p_row->>'category'),char_length(p_row->>'brand'),char_length(p_row->>'line'))>80
    or (p_row->>'kind') not in ('sale','return')
    or (p_row->>'totalAmount') !~ '^-?(0|[1-9][0-9]{0,9})\.[0-9]{2}$'
    or (p_row->>'totalAmount')='-0.00' then
    raise exception using errcode='P0001',message='VALIDATION_FAILED';
  end if;
  parsed_date:=(p_row->>'saleDate')::date;
  if parsed_date<date '1900-01-01' or to_char(parsed_date,'YYYY-MM-DD')<>p_row->>'saleDate' then
    raise exception using errcode='P0001',message='VALIDATION_FAILED';
  end if;
  amount:=(p_row->>'totalAmount')::numeric(12,2);
  if not (((p_row->>'kind')='sale' and (p_row->>'volume')::integer>0 and amount>=0)
    or ((p_row->>'kind')='return' and (p_row->>'volume')::integer<0 and amount<=0)) then
    raise exception using errcode='P0001',message='VALIDATION_FAILED';
  end if;
  return encode(extensions.digest(convert_to('['||compact||']','UTF8'),'sha256'),'hex');
exception when invalid_text_representation or datetime_field_overflow or numeric_value_out_of_range then
  raise exception using errcode='P0001',message='VALIDATION_FAILED';
end
$function$;

create function api.begin_sales_sheet_sync(p_source_key text,p_request_key text,p_trigger text default 'manual')
returns jsonb language plpgsql volatile security definer set search_path=''
as $function$
declare identity_document jsonb:=private.sales_source_identity(p_source_key); r private.sales_sync_runs;
  local_time timestamp:=clock_timestamp() at time zone 'America/Sao_Paulo';
begin
  if p_trigger is null or p_trigger not in ('manual','scheduled') or p_request_key is null
    or (p_trigger='manual' and p_request_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    or (p_trigger='scheduled' and p_request_key !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}@06:15$') then
    raise exception using errcode='P0001',message='VALIDATION_FAILED';
  end if;
  if not pg_try_advisory_xact_lock(hashtextextended('cirne:sales-sync:'||p_source_key,0)) then
    raise exception using errcode='P0001',message='SYNC_BUSY';
  end if;
  update private.sales_sync_runs set status='failed',error_code='SYNC_LEASE_EXPIRED',completed_at=lease_expires_at,updated_at=clock_timestamp()
    where source_key=p_source_key and status='collecting' and lease_expires_at<=clock_timestamp();
  select * into r from private.sales_sync_runs where source_key=p_source_key and request_key=p_request_key;
  if found then
    if r.requested_by<>(identity_document->>'id')::uuid then raise exception using errcode='P0001',message='NOT_FOUND'; end if;
    if r.trigger<>p_trigger then raise exception using errcode='P0001',message='VERSION_CONFLICT'; end if;
    -- Same authorized intention can recover a lost begin response. Chunk hashes
    -- and terminal publication enforce convergence; a different intent stays busy.
    return jsonb_build_object('runId',r.id,'leaseToken',case when r.status='collecting' then r.lease_token else null end,
      'replayed',true,'result',private.sales_sync_document(r.id));
  end if;
  if p_trigger='scheduled' and (extract(hour from local_time)<>6 or extract(minute from local_time)<15
    or p_request_key<>to_char(local_time,'YYYY-MM-DD')||'@06:15') then
    raise exception using errcode='P0001',message='VALIDATION_FAILED';
  end if;
  if exists(select 1 from private.sales_sync_runs where source_key=p_source_key and status='collecting') then
    raise exception using errcode='P0001',message='SYNC_BUSY';
  end if;
  insert into private.sales_sync_runs(source_key,request_key,trigger,requested_by,lease_expires_at)
    values(p_source_key,p_request_key,p_trigger,(identity_document->>'id')::uuid,clock_timestamp()+interval '10 minutes') returning * into r;
  return jsonb_build_object('runId',r.id,'leaseToken',r.lease_token,'replayed',false,'result',private.sales_sync_document(r.id));
end
$function$;

create function api.stage_sales_sheet_sync(p_run_id uuid,p_lease_token uuid,p_chunk_index integer,p_chunk_hash text,p_rows jsonb)
returns jsonb language plpgsql volatile security definer set search_path=''
as $function$
declare r private.sales_sync_runs:=private.sales_locked_run(p_run_id,p_lease_token);
  existing_chunk private.sales_sync_chunks; actual_hash text; row_count integer; prior_row integer:=0; source_row_number integer; row_document jsonb;
begin
  if p_chunk_index is null or p_chunk_index not between 0 and 99999 or p_chunk_hash is null or p_chunk_hash !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(p_rows) is distinct from 'array' then raise exception using errcode='P0001',message='VALIDATION_FAILED'; end if;
  row_count:=jsonb_array_length(p_rows);
  if row_count not between 1 and 1000 then raise exception using errcode='P0001',message='VALIDATION_FAILED'; end if;
  -- Ordered, unique original row numbers; source duplicates are never silently merged.
  for row_document in select value from jsonb_array_elements(p_rows) loop
    perform private.sales_row_hash(row_document);
    source_row_number:=(row_document->>'sourceRow')::integer;
    if source_row_number<=prior_row then raise exception using errcode='P0001',message='VALIDATION_FAILED'; end if;
    prior_row:=source_row_number;
  end loop;
  select encode(extensions.digest(convert_to(string_agg(private.sales_row_hash(value),'' order by ordinality),'UTF8'),'sha256'),'hex')
    into actual_hash from jsonb_array_elements(p_rows) with ordinality;
  if actual_hash<>p_chunk_hash then raise exception using errcode='P0001',message='VERSION_CONFLICT'; end if;
  select * into existing_chunk from private.sales_sync_chunks where run_id=r.id and chunk_index=p_chunk_index;
  if found then
    if existing_chunk.chunk_hash<>actual_hash or existing_chunk.row_count<>row_count then raise exception using errcode='P0001',message='VERSION_CONFLICT'; end if;
    return jsonb_build_object('stagedCount',r.staged_row_count,'replayed',true);
  end if;
  if r.status<>'collecting' then raise exception using errcode='P0001',message='VERSION_CONFLICT'; end if;
  if r.staged_row_count+row_count>100000 then raise exception using errcode='P0001',message='VALIDATION_FAILED'; end if;
  insert into private.sales_snapshot_lines(run_id,source_row,external_key,client_external_reference,invoice_number,sale_date,sku,product_description,item_group,item_subgroup,category,brand,line,kind,volume,total_amount,row_hash)
  select r.id,(value->>'sourceRow')::integer,value->>'externalKey',value->>'clientExternalReference',value->>'invoiceNumber',(value->>'saleDate')::date,
    value->>'sku',value->>'productDescription',value->>'itemGroup',value->>'itemSubgroup',value->>'category',value->>'brand',value->>'line',
    value->>'kind',(value->>'volume')::integer,(value->>'totalAmount')::numeric(12,2),private.sales_row_hash(value)
    from jsonb_array_elements(p_rows);
  insert into private.sales_sync_chunks(run_id,chunk_index,chunk_hash,row_count) values(r.id,p_chunk_index,actual_hash,row_count);
  update private.sales_sync_runs set staged_row_count=staged_row_count+row_count,fetched_at=clock_timestamp(),updated_at=clock_timestamp() where id=r.id;
  return jsonb_build_object('stagedCount',r.staged_row_count+row_count,'replayed',false);
exception when unique_violation or check_violation then raise exception using errcode='P0001',message='VALIDATION_FAILED';
end
$function$;

create function api.publish_sales_sheet_sync(p_run_id uuid,p_lease_token uuid,p_content_hash text,p_expected_row_count integer,p_parser_version integer,p_origin text default 'cli')
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
  insert into private.sales_sync_issues(run_id,source_row,code)
    select r.id,l.source_row,'CLIENT_NOT_FOUND' from private.sales_snapshot_lines l
    where l.run_id=r.id and not exists(select 1 from api.clients c where c.external_reference=l.client_external_reference);
  select count(distinct l.client_external_reference)::integer into unmatched from private.sales_snapshot_lines l
    where l.run_id=r.id and not exists(select 1 from api.clients c where c.external_reference=l.client_external_reference);
  update private.sales_sync_runs set status='published',content_hash=actual_hash,parser_version=p_parser_version,source_row_count=actual_count,
    unmatched_client_count=unmatched,issue_count=(select count(*) from private.sales_sync_issues where run_id=r.id),
    observed_min_date=min_date,observed_max_date=max_date,completed_at=clock_timestamp(),updated_at=clock_timestamp() where id=r.id;
  update private.sales_sources set published_run_id=r.id,updated_at=clock_timestamp() where source_key=r.source_key;
  insert into private.audit_events(actor_id,target_type,target_id,action,after_data,origin,request_id)
    values(r.requested_by,'sales_sync',r.id,'sales.published',jsonb_build_object('rowCount',actual_count,'contentHash',actual_hash,'parserVersion',p_parser_version),p_origin,r.id);
  return private.sales_sync_document(r.id);
end
$function$;

create function api.fail_sales_sheet_sync(p_run_id uuid,p_lease_token uuid,p_error_code text)
returns jsonb language plpgsql volatile security definer set search_path=''
as $function$
declare r private.sales_sync_runs:=private.sales_locked_run(p_run_id,p_lease_token);
begin
  if p_error_code is null or p_error_code not in ('SOURCE_UNAVAILABLE','SOURCE_INVALID','SOURCE_CHANGED','SOURCE_TOO_LARGE','VALIDATION_FAILED','PERSISTENCE_FAILED','INTERRUPTED') then
    raise exception using errcode='P0001',message='VALIDATION_FAILED';
  end if;
  if r.status='collecting' then
    update private.sales_sync_runs set status='failed',error_code=p_error_code,completed_at=clock_timestamp(),updated_at=clock_timestamp() where id=r.id;
  end if;
  return private.sales_sync_document(r.id);
end
$function$;

create function api.get_sales_sheet_sync_status(p_source_key text)
returns jsonb language plpgsql volatile security definer set search_path=''
as $function$
declare identity_document jsonb:=private.sales_source_identity(p_source_key); latest_id uuid; head_id uuid;
begin
  select id into latest_id from private.sales_sync_runs where source_key=p_source_key order by started_at desc,id desc limit 1;
  select published_run_id into head_id from private.sales_sources where source_key=p_source_key;
  return jsonb_build_object('latestRun',private.sales_sync_document(latest_id),'lastPublishedRun',private.sales_sync_document(head_id));
end
$function$;

create function private.sales_client_context(p_client_id uuid,p_snapshot_id uuid)
returns jsonb language plpgsql stable security definer set search_path=''
as $function$
declare identity_document jsonb:=private.route_identity('sales.read_client'); c api.clients; r private.sales_sync_runs;
begin
  -- No administrator shortcut: even administrator+manager is constrained by scopeIds.
  select * into c from api.clients client where client.id=p_client_id and exists(
    select 1 from api.client_seller_scopes scope where scope.client_id=client.id and scope.revoked_at is null
      and identity_document->'scopeIds' ? scope.seller_id::text);
  if not found then raise exception using errcode='P0001',message='NOT_FOUND'; end if;
  select run.* into r from private.sales_sources source join private.sales_sync_runs run on run.id=source.published_run_id
    where run.status='published';
  if not found then raise exception using errcode='P0001',message='NOT_FOUND'; end if;
  if p_snapshot_id is not null and p_snapshot_id<>r.id then raise exception using errcode='P0001',message='VERSION_CONFLICT'; end if;
  return jsonb_build_object('generationId',r.id,'fetchedAt',r.fetched_at,'publishedAt',r.completed_at,
    'observedFrom',r.observed_min_date,'observedThrough',r.observed_max_date,
    'asOfDate',(now() at time zone 'America/Sao_Paulo')::date,'client',jsonb_build_object('id',c.id,'name',c.name),
    'reference',c.external_reference);
end
$function$;

create function api.get_client_sales_page(p_client_id uuid,p_snapshot_id uuid default null,p_after_row integer default 0)
returns jsonb language plpgsql stable security definer set search_path=''
as $function$
declare context jsonb:=private.sales_client_context(p_client_id,p_snapshot_id); page_rows jsonb; next_row integer;
begin
  if p_after_row is null or p_after_row not between 0 and 100001 then raise exception using errcode='P0001',message='VALIDATION_FAILED'; end if;
  with selected as (
    select * from private.sales_snapshot_lines where run_id=(context->>'generationId')::uuid
      and client_external_reference=context->>'reference' and source_row>p_after_row order by source_row limit 1001
  ), page as (select * from selected order by source_row limit 1000)
  select coalesce(jsonb_agg(jsonb_build_object('saleDate',sale_date,'invoiceNumber',invoice_number,'sku',sku,
    'productDescription',product_description,'itemGroup',item_group,'itemSubgroup',item_subgroup,'category',category,'brand',brand,'line',line,
    'kind',kind,'volume',volume,'totalAmount',total_amount::text) order by source_row),'[]'::jsonb),
    case when (select count(*) from selected)>1000 then max(source_row) else null end
  into page_rows,next_row from page;
  return (context-'reference')||jsonb_build_object('rows',page_rows,'nextAfterRow',next_row);
end
$function$;

create function api.get_client_sales_products(p_client_id uuid,p_snapshot_id uuid,p_after_sku text default null)
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
  return jsonb_build_object('generationId',context->'generationId','products',products,'nextAfterSku',next_sku);
end
$function$;

-- Private helpers are never callable through the Data API, even by service_role.
do $functions$
declare function_row record;
begin
  for function_row in select p.oid::regprocedure as signature,n.nspname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where (n.nspname='private' and p.proname in ('sales_source_identity','sales_sync_document','sales_locked_run','sales_row_hash','sales_client_context'))
      or (n.nspname='api' and p.proname in ('begin_sales_sheet_sync','stage_sales_sheet_sync','publish_sales_sheet_sync','fail_sales_sheet_sync','get_sales_sheet_sync_status','get_client_sales_page','get_client_sales_products')) loop
    execute format('alter function %s owner to cirne_route_executor',function_row.signature);
    execute format('revoke all on function %s from public,anon,authenticated,service_role',function_row.signature);
    if function_row.nspname='api' then execute format('grant execute on function %s to authenticated',function_row.signature); end if;
  end loop;
end
$functions$;
revoke create on schema api,private from cirne_route_executor;
do $membership$
begin
  execute pg_catalog.format('revoke cirne_route_executor from %I granted by current_user',current_user);
end
$membership$;
commit;
