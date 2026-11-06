-- Story 4.15 / ADR 007. Private, immutable Google product-catalog generations.
-- Operational rollback: keep this additive schema, disable the feature/configuration,
-- and leave private.product_catalog_sources without an active actor/head.
begin;
select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cirne:database:migrate'));
set local lock_timeout='5s';

do $membership$
begin
  execute pg_catalog.format('grant cirne_route_executor to %I with set true granted by current_user',current_user);
end
$membership$;
grant usage,create on schema api,private to cirne_route_executor;

-- Provisioning stays an administrative operation. The application executor can
-- read the binding and atomically move only the published head.
create table private.product_catalog_sources (
  source_key text primary key check(source_key ~ '^[0-9a-f]{64}$'),
  singleton boolean not null default true unique check(singleton),
  sync_actor_id uuid references api.user_profiles(id) on delete restrict,
  published_run_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
create index product_catalog_sources_actor_idx on private.product_catalog_sources(sync_actor_id);
create index product_catalog_sources_head_idx on private.product_catalog_sources(published_run_id);
alter table private.product_catalog_sources enable row level security;
alter table private.product_catalog_sources force row level security;
revoke all on private.product_catalog_sources from public,anon,authenticated,service_role;
grant select on private.product_catalog_sources to cirne_route_executor;
grant update(published_run_id,updated_at) on private.product_catalog_sources to cirne_route_executor;
create policy product_catalog_sources_read on private.product_catalog_sources
  for select to cirne_route_executor using(true);
create policy product_catalog_sources_publish on private.product_catalog_sources
  for update to cirne_route_executor using(true) with check(true);
comment on table private.product_catalog_sources is
  'Single private Base produtos source. DB administration provisions source+actor; NULL actor revokes sync. No role receives products.sync automatically.';

create table private.product_catalog_sync_runs (
  id uuid primary key default gen_random_uuid(),
  source_key text not null references private.product_catalog_sources(source_key) on delete restrict,
  request_key text not null check(request_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  trigger text not null check(trigger='manual'),
  requested_by uuid not null references api.user_profiles(id) on delete restrict,
  lease_token uuid not null default gen_random_uuid(),
  lease_expires_at timestamptz not null,
  status text not null default 'collecting' check(status in ('collecting','published','failed')),
  content_hash text check(content_hash ~ '^[0-9a-f]{64}$'),
  parser_version integer check(parser_version=1),
  source_row_count integer not null default 0 check(source_row_count between 0 and 10000),
  staged_row_count integer not null default 0 check(staged_row_count between 0 and 10000),
  issue_count integer not null default 0 check(issue_count between 0 and 100000),
  fetched_at timestamptz,
  error_code text check(error_code ~ '^[A-Z][A-Z0-9_]{0,79}$'),
  started_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique(source_key,request_key),
  check((status='collecting')=(completed_at is null)),
  check(status<>'published' or (source_row_count>0 and source_row_count=staged_row_count
    and content_hash is not null and parser_version is not null))
);
alter table private.product_catalog_sources add constraint product_catalog_sources_head_fk
  foreign key(published_run_id) references private.product_catalog_sync_runs(id) on delete restrict;
create unique index product_catalog_active_source_idx on private.product_catalog_sync_runs(source_key)
  where status='collecting';
create index product_catalog_runs_latest_idx on private.product_catalog_sync_runs(source_key,started_at desc,id desc);
create index product_catalog_runs_actor_idx on private.product_catalog_sync_runs(requested_by);

create table private.product_catalog_sync_chunks (
  run_id uuid not null references private.product_catalog_sync_runs(id) on delete restrict,
  chunk_index integer not null check(chunk_index between 0 and 9999),
  chunk_hash text not null check(chunk_hash ~ '^[0-9a-f]{64}$'),
  row_count integer not null check(row_count between 1 and 500),
  created_at timestamptz not null default clock_timestamp(),
  primary key(run_id,chunk_index)
);

create table private.product_catalog_snapshot_items (
  run_id uuid not null references private.product_catalog_sync_runs(id) on delete restrict,
  source_row integer not null check(source_row between 2 and 10001),
  factory_code text not null check(char_length(factory_code) between 1 and 80 and factory_code<>'SEM TAB'),
  cirne_code text not null check(char_length(cirne_code)<=80),
  category text not null check(char_length(category)<=120),
  description text not null check(char_length(description) between 1 and 240),
  original_item text not null check(char_length(original_item) between 1 and 240),
  base_sku text not null check(char_length(base_sku) between 1 and 120),
  brand text not null check(char_length(brand) between 1 and 120),
  technology text not null check(char_length(technology)<=120),
  technology_abbreviation text not null check(char_length(technology_abbreviation)<=40),
  amperage_ah text not null check(char_length(amperage_ah)<=80),
  cca_a text not null check(char_length(cca_a)<=80),
  voltage_v text not null check(char_length(voltage_v)<=80),
  positive_pole_position text not null check(char_length(positive_pole_position)<=120),
  weight_kg text not null check(char_length(weight_kg)<=80),
  dimensions_axcxl_mm text not null check(char_length(dimensions_axcxl_mm)<=120),
  dimensions_cxlxa_mm text not null check(char_length(dimensions_cxlxa_mm)<=120),
  market_average_price text not null check(char_length(market_average_price)<=80),
  common_applications text not null check(char_length(common_applications)<=1000),
  row_hash text not null check(row_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  primary key(run_id,source_row),
  unique(run_id,factory_code)
);
create index product_catalog_items_code_idx
  on private.product_catalog_snapshot_items(run_id,factory_code collate "C");

-- Pair-specific, private evidence for sales SKUs absent when a catalog generation
-- was published. Current CRM coverage is recalculated for its pinned generation pair.
create table private.product_catalog_sales_diagnostics (
  catalog_run_id uuid not null references private.product_catalog_sync_runs(id) on delete restrict,
  sales_run_id uuid not null references private.sales_sync_runs(id) on delete restrict,
  sku text not null check(char_length(sku) between 1 and 80),
  code text not null check(code='CATALOG_MISSING'),
  created_at timestamptz not null default clock_timestamp(),
  primary key(catalog_run_id,sales_run_id,sku,code)
);
create index product_catalog_diagnostics_pair_idx
  on private.product_catalog_sales_diagnostics(sales_run_id,catalog_run_id);
comment on table private.product_catalog_snapshot_items is
  'Immutable normalized A:R evidence. market_average_price is private and excluded from every commercial projection.';
comment on table private.product_catalog_sales_diagnostics is
  'Private exact-code diagnostics for one immutable catalog/sales generation pair; never changes sales facts.';

do $tables$
declare table_name text;
begin
  foreach table_name in array array['product_catalog_sync_runs','product_catalog_sync_chunks',
    'product_catalog_snapshot_items','product_catalog_sales_diagnostics'] loop
    execute format('alter table private.%I enable row level security',table_name);
    execute format('alter table private.%I force row level security',table_name);
    execute format('revoke all on private.%I from public,anon,authenticated,service_role',table_name);
    execute format('alter table private.%I owner to cirne_route_executor',table_name);
    execute format('create policy %I on private.%I for select to cirne_route_executor using(true)',table_name||'_read',table_name);
    execute format('create policy %I on private.%I for insert to cirne_route_executor with check(true)',table_name||'_insert',table_name);
  end loop;
end
$tables$;
create policy product_catalog_runs_update on private.product_catalog_sync_runs
  for update to cirne_route_executor using(true) with check(true);

set local role cirne_route_executor;

create function private.guard_terminal_product_catalog_run()
returns trigger language plpgsql security invoker set search_path=''
as $function$
begin
  if old.status in ('published','failed') then
    raise exception using errcode='P0001',message='VERSION_CONFLICT';
  end if;
  return new;
end
$function$;
create trigger product_catalog_runs_guard_terminal
before update on private.product_catalog_sync_runs
for each row execute function private.guard_terminal_product_catalog_run();

create function private.product_catalog_source_identity(p_source_key text)
returns jsonb language plpgsql volatile security definer set search_path=''
as $function$
declare identity_document jsonb:=private.route_identity('products.sync');
begin
  if p_source_key is null or p_source_key !~ '^[0-9a-f]{64}$' then
    raise exception using errcode='P0001',message='VALIDATION_FAILED';
  end if;
  perform 1 from private.product_catalog_sources where source_key=p_source_key
    and sync_actor_id=(identity_document->>'id')::uuid for share;
  if not found then raise exception using errcode='P0001',message='FORBIDDEN'; end if;
  return identity_document;
end
$function$;

create function private.product_catalog_sync_document(p_run_id uuid)
returns jsonb language sql stable security definer set search_path=''
as $function$
  select jsonb_build_object('id',r.id,'sourceKey',r.source_key,
    'status',case when r.status='collecting' and r.lease_expires_at<=now() then 'failed' else r.status end,
    'trigger',r.trigger,'startedAt',r.started_at,
    'completedAt',case when r.status='collecting' and r.lease_expires_at<=now() then r.lease_expires_at else r.completed_at end,
    'generationId',case when r.status='published' then r.id else null end,
    'contentHash',r.content_hash,'parserVersion',r.parser_version,
    'sourceRowCount',r.source_row_count,'stagedRowCount',r.staged_row_count,
    'errorCode',case when r.status='collecting' and r.lease_expires_at<=now()
      then 'SYNC_LEASE_EXPIRED' else r.error_code end)
  from private.product_catalog_sync_runs r where r.id=p_run_id;
$function$;

create function private.product_catalog_locked_run(p_run_id uuid,p_lease_token uuid)
returns private.product_catalog_sync_runs language plpgsql volatile security definer set search_path=''
as $function$
declare r private.product_catalog_sync_runs; identity_document jsonb:=private.route_identity('products.sync');
begin
  select * into r from private.product_catalog_sync_runs where id=p_run_id;
  if not found then raise exception using errcode='P0001',message='NOT_FOUND'; end if;
  identity_document:=private.product_catalog_source_identity(r.source_key);
  if r.requested_by<>(identity_document->>'id')::uuid or p_lease_token is null or r.lease_token<>p_lease_token then
    raise exception using errcode='P0001',message='NOT_FOUND';
  end if;
  if not pg_try_advisory_xact_lock(hashtextextended('cirne:product-catalog-sync:'||r.source_key,0)) then
    raise exception using errcode='P0001',message='SYNC_BUSY';
  end if;
  select * into r from private.product_catalog_sync_runs where id=p_run_id for update;
  if r.status='collecting' and r.lease_expires_at<=clock_timestamp() then
    raise exception using errcode='P0001',message='SYNC_LEASE_EXPIRED';
  end if;
  return r;
end
$function$;

-- Canonical tuple has sourceRow plus all 18 A:R values. Every value is present,
-- trimmed and NFC. Optional cells are represented by the empty string.
create function private.product_catalog_row_hash(p_row jsonb)
returns text language plpgsql immutable security definer set search_path=''
as $function$
declare
  names text[]:=array['sourceRow','factoryCode','cirneCode','category','description','originalItem','baseSku','brand',
    'technology','technologyAbbreviation','amperageAh','ccaA','voltageV','positivePolePosition','weightKg',
    'dimensionsAxCxLmm','dimensionsCxLxAmm','marketAveragePrice','commonApplications'];
  key_name text; scalar jsonb; compact text:=''; value_text text;
begin
  if jsonb_typeof(p_row) is distinct from 'object' or (select count(*) from jsonb_object_keys(p_row))<>19 then
    raise exception using errcode='P0001',message='VALIDATION_FAILED';
  end if;
  foreach key_name in array names loop
    scalar:=p_row->key_name;
    if key_name='sourceRow' then
      if jsonb_typeof(scalar) is distinct from 'number' or scalar::text !~ '^[0-9]+$' then
        raise exception using errcode='P0001',message='VALIDATION_FAILED';
      end if;
    else
      value_text:=p_row->>key_name;
      if jsonb_typeof(scalar) is distinct from 'string' or value_text ~ '[\x00-\x1f\x7f]'
        or value_text<>btrim(value_text) or value_text<>normalize(value_text,NFC) then
        raise exception using errcode='P0001',message='VALIDATION_FAILED';
      end if;
    end if;
    compact:=compact||case when compact='' then '' else ',' end||scalar::text;
  end loop;
  if (p_row->>'sourceRow')::numeric not between 2 and 10001
    or char_length(p_row->>'factoryCode') not between 1 and 80 or (p_row->>'factoryCode')='SEM TAB'
    or char_length(p_row->>'cirneCode')>80 or char_length(p_row->>'category')>120
    or char_length(p_row->>'description') not between 1 and 240
    or char_length(p_row->>'originalItem') not between 1 and 240
    or char_length(p_row->>'baseSku') not between 1 and 120
    or char_length(p_row->>'brand') not between 1 and 120
    or char_length(p_row->>'technology')>120 or char_length(p_row->>'technologyAbbreviation')>40
    or char_length(p_row->>'amperageAh')>80 or char_length(p_row->>'ccaA')>80
    or char_length(p_row->>'voltageV')>80 or char_length(p_row->>'positivePolePosition')>120
    or char_length(p_row->>'weightKg')>80 or char_length(p_row->>'dimensionsAxCxLmm')>120
    or char_length(p_row->>'dimensionsCxLxAmm')>120 or char_length(p_row->>'marketAveragePrice')>80
    or char_length(p_row->>'commonApplications')>1000 then
    raise exception using errcode='P0001',message='VALIDATION_FAILED';
  end if;
  return encode(extensions.digest(convert_to('['||compact||']','UTF8'),'sha256'),'hex');
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception using errcode='P0001',message='VALIDATION_FAILED';
end
$function$;

create function api.begin_product_catalog_sync(p_source_key text,p_request_key text,p_trigger text default 'manual')
returns jsonb language plpgsql volatile security definer set search_path=''
as $function$
declare identity_document jsonb:=private.product_catalog_source_identity(p_source_key);
  r private.product_catalog_sync_runs;
begin
  if p_trigger is distinct from 'manual' or p_request_key is null
    or p_request_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception using errcode='P0001',message='VALIDATION_FAILED';
  end if;
  if not pg_try_advisory_xact_lock(hashtextextended('cirne:product-catalog-sync:'||p_source_key,0)) then
    raise exception using errcode='P0001',message='SYNC_BUSY';
  end if;
  update private.product_catalog_sync_runs set status='failed',error_code='SYNC_LEASE_EXPIRED',
    completed_at=lease_expires_at,updated_at=clock_timestamp()
    where source_key=p_source_key and status='collecting' and lease_expires_at<=clock_timestamp();
  select * into r from private.product_catalog_sync_runs
    where source_key=p_source_key and request_key=p_request_key;
  if found then
    if r.requested_by<>(identity_document->>'id')::uuid then
      raise exception using errcode='P0001',message='NOT_FOUND';
    end if;
    if r.trigger<>p_trigger then raise exception using errcode='P0001',message='VERSION_CONFLICT'; end if;
    return jsonb_build_object('runId',r.id,
      'leaseToken',case when r.status='collecting' then r.lease_token else null end,
      'replayed',true,'result',private.product_catalog_sync_document(r.id));
  end if;
  if exists(select 1 from private.product_catalog_sync_runs
    where source_key=p_source_key and status='collecting') then
    raise exception using errcode='P0001',message='SYNC_BUSY';
  end if;
  insert into private.product_catalog_sync_runs(source_key,request_key,trigger,requested_by,lease_expires_at)
    values(p_source_key,p_request_key,p_trigger,(identity_document->>'id')::uuid,
      clock_timestamp()+interval '10 minutes') returning * into r;
  return jsonb_build_object('runId',r.id,'leaseToken',r.lease_token,'replayed',false,
    'result',private.product_catalog_sync_document(r.id));
end
$function$;

create function api.stage_product_catalog_sync(p_run_id uuid,p_lease_token uuid,p_chunk_index integer,
  p_chunk_hash text,p_rows jsonb)
returns jsonb language plpgsql volatile security definer set search_path=''
as $function$
declare r private.product_catalog_sync_runs:=private.product_catalog_locked_run(p_run_id,p_lease_token);
  existing_chunk private.product_catalog_sync_chunks; actual_hash text; row_count integer;
  prior_row integer:=0; source_row_number integer; row_document jsonb;
begin
  if p_chunk_index is null or p_chunk_index not between 0 and 9999
    or p_chunk_hash is null or p_chunk_hash !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception using errcode='P0001',message='VALIDATION_FAILED';
  end if;
  row_count:=jsonb_array_length(p_rows);
  if row_count not between 1 and 500 then raise exception using errcode='P0001',message='VALIDATION_FAILED'; end if;
  for row_document in select value from jsonb_array_elements(p_rows) loop
    perform private.product_catalog_row_hash(row_document);
    source_row_number:=(row_document->>'sourceRow')::integer;
    if source_row_number<=prior_row then raise exception using errcode='P0001',message='VALIDATION_FAILED'; end if;
    prior_row:=source_row_number;
  end loop;
  select encode(extensions.digest(convert_to(
    string_agg(private.product_catalog_row_hash(value),'' order by ordinality),'UTF8'),'sha256'),'hex')
    into actual_hash from jsonb_array_elements(p_rows) with ordinality;
  if actual_hash<>p_chunk_hash then raise exception using errcode='P0001',message='VERSION_CONFLICT'; end if;
  select * into existing_chunk from private.product_catalog_sync_chunks
    where run_id=r.id and chunk_index=p_chunk_index;
  if found then
    if existing_chunk.chunk_hash<>actual_hash or existing_chunk.row_count<>row_count then
      raise exception using errcode='P0001',message='VERSION_CONFLICT';
    end if;
    return jsonb_build_object('stagedCount',r.staged_row_count,'replayed',true);
  end if;
  if r.status<>'collecting' then raise exception using errcode='P0001',message='VERSION_CONFLICT'; end if;
  if r.staged_row_count+row_count>10000 then raise exception using errcode='P0001',message='VALIDATION_FAILED'; end if;
  insert into private.product_catalog_snapshot_items(run_id,source_row,factory_code,cirne_code,category,
    description,original_item,base_sku,brand,technology,technology_abbreviation,amperage_ah,cca_a,
    voltage_v,positive_pole_position,weight_kg,dimensions_axcxl_mm,dimensions_cxlxa_mm,
    market_average_price,common_applications,row_hash)
  select r.id,(value->>'sourceRow')::integer,value->>'factoryCode',value->>'cirneCode',value->>'category',
    value->>'description',value->>'originalItem',value->>'baseSku',value->>'brand',value->>'technology',
    value->>'technologyAbbreviation',value->>'amperageAh',value->>'ccaA',value->>'voltageV',
    value->>'positivePolePosition',value->>'weightKg',value->>'dimensionsAxCxLmm',
    value->>'dimensionsCxLxAmm',value->>'marketAveragePrice',value->>'commonApplications',
    private.product_catalog_row_hash(value)
  from jsonb_array_elements(p_rows);
  insert into private.product_catalog_sync_chunks(run_id,chunk_index,chunk_hash,row_count)
    values(r.id,p_chunk_index,actual_hash,row_count);
  update private.product_catalog_sync_runs set staged_row_count=staged_row_count+row_count,
    fetched_at=clock_timestamp(),updated_at=clock_timestamp() where id=r.id;
  return jsonb_build_object('stagedCount',r.staged_row_count+row_count,'replayed',false);
exception when unique_violation or check_violation then
  raise exception using errcode='P0001',message='VALIDATION_FAILED';
end
$function$;

create function api.publish_product_catalog_sync(p_run_id uuid,p_lease_token uuid,p_content_hash text,
  p_expected_row_count integer,p_parser_version integer,p_origin text default 'cli')
returns jsonb language plpgsql volatile security definer set search_path=''
as $function$
declare r private.product_catalog_sync_runs:=private.product_catalog_locked_run(p_run_id,p_lease_token);
  actual_hash text; actual_count integer; chunk_count integer; last_chunk integer; sales_head uuid;
begin
  if p_content_hash is null or p_content_hash !~ '^[0-9a-f]{64}$'
    or p_expected_row_count is null or p_expected_row_count not between 1 and 10000
    or p_parser_version is distinct from 1 or p_origin is null or p_origin not in ('cli','web','system') then
    raise exception using errcode='P0001',message='VALIDATION_FAILED';
  end if;
  if r.status='published' then
    if r.content_hash<>p_content_hash or r.source_row_count<>p_expected_row_count
      or r.parser_version<>p_parser_version then
      raise exception using errcode='P0001',message='VERSION_CONFLICT';
    end if;
    return private.product_catalog_sync_document(r.id);
  elsif r.status='failed' then
    return private.product_catalog_sync_document(r.id);
  end if;
  select count(*)::integer,
    encode(extensions.digest(convert_to(string_agg(row_hash,'' order by source_row),'UTF8'),'sha256'),'hex')
    into actual_count,actual_hash from private.product_catalog_snapshot_items where run_id=r.id;
  select count(*)::integer,max(chunk_index) into chunk_count,last_chunk
    from private.product_catalog_sync_chunks where run_id=r.id;
  if actual_count<>p_expected_row_count or actual_count<>r.staged_row_count
    or actual_hash is distinct from p_content_hash or chunk_count=0 or last_chunk<>chunk_count-1
    or (select sum(row_count) from private.product_catalog_sync_chunks where run_id=r.id)<>actual_count then
    raise exception using errcode='P0001',message='VERSION_CONFLICT';
  end if;
  select published_run_id into sales_head from private.sales_sources where singleton;
  if sales_head is not null then
    insert into private.product_catalog_sales_diagnostics(catalog_run_id,sales_run_id,sku,code)
    select r.id,sales_head,sale.sku,'CATALOG_MISSING'
    from (select distinct sku from private.sales_snapshot_lines where run_id=sales_head) sale
    where not exists(select 1 from private.product_catalog_snapshot_items item
      where item.run_id=r.id and item.factory_code=sale.sku);
  end if;
  update private.product_catalog_sync_runs set status='published',content_hash=actual_hash,
    parser_version=p_parser_version,source_row_count=actual_count,
    issue_count=(select count(*) from private.product_catalog_sales_diagnostics where catalog_run_id=r.id),
    completed_at=clock_timestamp(),updated_at=clock_timestamp() where id=r.id;
  update private.product_catalog_sources set published_run_id=r.id,updated_at=clock_timestamp()
    where source_key=r.source_key;
  insert into private.audit_events(actor_id,target_type,target_id,action,after_data,origin,request_id)
    values(r.requested_by,'product_catalog_sync',r.id,'products.published',
      jsonb_build_object('rowCount',actual_count,'contentHash',actual_hash,'parserVersion',p_parser_version),
      p_origin,r.id);
  return private.product_catalog_sync_document(r.id);
end
$function$;

create function api.fail_product_catalog_sync(p_run_id uuid,p_lease_token uuid,p_error_code text)
returns jsonb language plpgsql volatile security definer set search_path=''
as $function$
declare r private.product_catalog_sync_runs:=private.product_catalog_locked_run(p_run_id,p_lease_token);
begin
  if p_error_code is null or p_error_code not in ('SOURCE_UNAVAILABLE','SOURCE_INVALID','SOURCE_CHANGED',
    'SOURCE_TOO_LARGE','VALIDATION_FAILED','PERSISTENCE_FAILED','INTERRUPTED') then
    raise exception using errcode='P0001',message='VALIDATION_FAILED';
  end if;
  if r.status='collecting' then
    update private.product_catalog_sync_runs set status='failed',error_code=p_error_code,
      completed_at=clock_timestamp(),updated_at=clock_timestamp() where id=r.id;
  end if;
  return private.product_catalog_sync_document(r.id);
end
$function$;

create function api.get_product_catalog_sync_status(p_source_key text)
returns jsonb language plpgsql volatile security definer set search_path=''
as $function$
declare identity_document jsonb:=private.product_catalog_source_identity(p_source_key);
  latest_id uuid; head_id uuid;
begin
  select id into latest_id from private.product_catalog_sync_runs where source_key=p_source_key
    order by started_at desc,id desc limit 1;
  select published_run_id into head_id from private.product_catalog_sources where source_key=p_source_key;
  return jsonb_build_object('latestRun',private.product_catalog_sync_document(latest_id),
    'lastPublishedRun',private.product_catalog_sync_document(head_id));
end
$function$;

create function private.product_catalog_client_context(p_client_id uuid,p_sales_generation_id uuid,
  p_catalog_generation_id uuid,p_as_of_date date,p_client_version integer)
returns jsonb language plpgsql stable security definer set search_path=''
as $function$
declare sales_context jsonb:=private.sales_client_context(p_client_id,p_sales_generation_id);
  catalog_run private.product_catalog_sync_runs; catalog_available boolean:=false;
begin
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
    if p_catalog_generation_id is not null then
      raise exception using errcode='P0001',message='VERSION_CONFLICT';
    end if;
    return jsonb_build_object('salesGenerationId',sales_context->'generationId',
      'fetchedAt',sales_context->'fetchedAt','publishedAt',sales_context->'publishedAt',
      'observedFrom',sales_context->'observedFrom','observedThrough',sales_context->'observedThrough',
      'catalogGenerationId',null,'asOfDate',sales_context->'asOfDate',
      'clientVersion',sales_context->'clientVersion','client',sales_context->'client',
      'reference',sales_context->'reference','catalog',jsonb_build_object('status','catalog_unavailable'));
  end if;
  if p_catalog_generation_id is not null and p_catalog_generation_id<>catalog_run.id then
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

create function private.product_catalog_item_document(item private.product_catalog_snapshot_items)
returns jsonb language sql immutable security definer set search_path=''
as $function$
  select jsonb_build_object('factoryCode',item.factory_code,'cirneCode',item.cirne_code,
    'category',item.category,'description',item.description,'originalItem',item.original_item,
    'baseSku',item.base_sku,'brand',item.brand,'technology',item.technology,
    'technologyAbbreviation',item.technology_abbreviation,'amperageAh',item.amperage_ah,
    'ccaA',item.cca_a,'voltageV',item.voltage_v,'positivePolePosition',item.positive_pole_position,
    'weightKg',item.weight_kg,'dimensionsAxCxLmm',item.dimensions_axcxl_mm,
    'dimensionsCxLxAmm',item.dimensions_cxlxa_mm,'commonApplications',item.common_applications);
$function$;

create function api.get_client_sales_catalog_context(p_client_id uuid,p_sales_snapshot_id uuid default null,
  p_catalog_snapshot_id uuid default null,p_as_of_date date default null,p_client_version integer default null)
returns jsonb language sql stable security definer set search_path=''
as $function$
  select private.product_catalog_client_context(p_client_id,p_sales_snapshot_id,p_catalog_snapshot_id,
    p_as_of_date,p_client_version)-'reference';
$function$;

create function api.get_client_product_opportunities(p_client_id uuid,p_sales_snapshot_id uuid,
  p_catalog_snapshot_id uuid,p_as_of_date date,p_client_version integer,
  p_page integer default 1)
returns jsonb language plpgsql stable security definer set search_path=''
as $function$
declare context jsonb; products jsonb; opportunity_count integer; total_pages integer;
  sales_product_count integer; matched_sales_product_count integer;
begin
  if p_sales_snapshot_id is null or p_as_of_date is null or p_client_version is null
    or p_page is null or p_page not between 1 and 4000 then
    raise exception using errcode='P0001',message='VALIDATION_FAILED';
  end if;
  context:=private.product_catalog_client_context(p_client_id,p_sales_snapshot_id,
    p_catalog_snapshot_id,p_as_of_date,p_client_version);
  if context->'catalog'->>'status'='catalog_unavailable' then
    return jsonb_build_object('salesGenerationId',context->'salesGenerationId',
      'catalogGenerationId',null,'asOfDate',context->'asOfDate','clientVersion',context->'clientVersion',
      'page',p_page,'pageSize',25,'totalCount',null,'totalPages',null,'coverage',null,'products',null);
  end if;
  if p_catalog_snapshot_id is null then
    raise exception using errcode='P0001',message='VALIDATION_FAILED';
  end if;
  select count(*)::integer into opportunity_count from private.product_catalog_snapshot_items item
  where item.run_id=p_catalog_snapshot_id and not exists(
    select 1 from private.sales_snapshot_lines sale
    where sale.run_id=p_sales_snapshot_id and sale.client_external_reference=context->>'reference'
      and sale.sale_date<=p_as_of_date and sale.sku=item.factory_code
      and sale.kind='sale' and sale.volume>0);
  total_pages:=case when opportunity_count=0 then 0 else ceil(opportunity_count/25.0)::integer end;
  with sales_skus as materialized (
    select distinct sale.sku from private.sales_snapshot_lines sale
    where sale.run_id=p_sales_snapshot_id and sale.sale_date<=p_as_of_date
  )
  select count(*)::integer,count(item.factory_code)::integer
    into sales_product_count,matched_sales_product_count
  from sales_skus sale left join private.product_catalog_snapshot_items item
    on item.run_id=p_catalog_snapshot_id and item.factory_code=sale.sku;
  with page as (
    select item.* from private.product_catalog_snapshot_items item
    where item.run_id=p_catalog_snapshot_id
      and not exists(select 1 from private.sales_snapshot_lines sale
        where sale.run_id=p_sales_snapshot_id and sale.client_external_reference=context->>'reference'
          and sale.sale_date<=p_as_of_date and sale.sku=item.factory_code
          and sale.kind='sale' and sale.volume>0)
    order by item.factory_code collate "C" limit 25 offset ((p_page-1)*25)
  )
  select coalesce(jsonb_agg(private.product_catalog_item_document(page)
    order by factory_code collate "C"),'[]'::jsonb) into products from page;
  return jsonb_build_object('salesGenerationId',context->'salesGenerationId',
    'catalogGenerationId',context->'catalogGenerationId','asOfDate',context->'asOfDate',
    'clientVersion',context->'clientVersion','availability','available','page',p_page,'pageSize',25,
    'totalCount',opportunity_count,'totalPages',total_pages,
    'coverage',jsonb_build_object('catalogProductCount',(context->'catalog'->>'rowCount')::integer,
      'salesProductCount',sales_product_count,'matchedSalesProductCount',matched_sales_product_count,
      'missingSalesProductCount',sales_product_count-matched_sales_product_count),
    'products',products);
end
$function$;

create function api.get_client_product_catalog_matches(p_client_id uuid,p_sales_snapshot_id uuid,
  p_catalog_snapshot_id uuid,p_as_of_date date,p_client_version integer,p_factory_codes text[])
returns jsonb language plpgsql stable security definer set search_path=''
as $function$
declare context jsonb; requested_count integer; matches jsonb;
begin
  requested_count:=cardinality(p_factory_codes);
  if p_sales_snapshot_id is null or p_as_of_date is null or p_client_version is null
    or p_factory_codes is null or array_ndims(p_factory_codes) is distinct from 1
    or requested_count not between 1 and 10
    or exists(select 1 from unnest(p_factory_codes) code where code is null
      or char_length(code) not between 1 and 80 or code<>btrim(code) or code<>normalize(code,NFC))
    or (select count(distinct code collate "C") from unnest(p_factory_codes) code)<>requested_count then
    raise exception using errcode='P0001',message='VALIDATION_FAILED';
  end if;
  context:=private.product_catalog_client_context(p_client_id,p_sales_snapshot_id,
    p_catalog_snapshot_id,p_as_of_date,p_client_version);
  if context->'catalog'->>'status'='catalog_unavailable' then
    return jsonb_build_object('salesGenerationId',context->'salesGenerationId',
      'catalogGenerationId',null,'asOfDate',context->'asOfDate',
      'clientVersion',context->'clientVersion','products',null);
  end if;
  if p_catalog_snapshot_id is null then
    raise exception using errcode='P0001',message='VALIDATION_FAILED';
  end if;
  select coalesce(jsonb_agg(private.product_catalog_item_document(item)
    order by item.factory_code collate "C"),'[]'::jsonb) into matches
  from private.product_catalog_snapshot_items item
  where item.run_id=p_catalog_snapshot_id and item.factory_code=any(p_factory_codes);
  return jsonb_build_object('salesGenerationId',context->'salesGenerationId',
    'catalogGenerationId',context->'catalogGenerationId','asOfDate',context->'asOfDate',
    'clientVersion',context->'clientVersion','products',matches);
end
$function$;

comment on function api.get_client_product_opportunities(uuid,uuid,uuid,date,integer,integer) is
  'Current-scope CRM projection: official products without a positive sale in the pinned available history. Page size 25; never exposes price or a global catalog.';
comment on function api.get_client_product_catalog_matches(uuid,uuid,uuid,date,integer,text[]) is
  'Current-scope exact enrichment for at most 10 sales SKUs. Unmatched sales remain owned by the sales response; never exposes price.';

-- Private helpers remain unreachable through the Data API, including service_role.
do $functions$
declare function_row record;
begin
  for function_row in
    select p.oid::regprocedure as signature,n.nspname from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
    where (n.nspname='private' and p.proname in ('product_catalog_source_identity',
      'product_catalog_sync_document','product_catalog_locked_run','product_catalog_row_hash',
      'product_catalog_client_context','product_catalog_item_document','guard_terminal_product_catalog_run'))
      or (n.nspname='api' and p.proname in ('begin_product_catalog_sync','stage_product_catalog_sync',
      'publish_product_catalog_sync','fail_product_catalog_sync','get_product_catalog_sync_status',
      'get_client_sales_catalog_context','get_client_product_opportunities',
      'get_client_product_catalog_matches')) loop
    execute format('alter function %s owner to cirne_route_executor',function_row.signature);
    execute format('revoke all on function %s from public,anon,authenticated,service_role',function_row.signature);
    if function_row.nspname='api' then
      execute format('grant execute on function %s to authenticated',function_row.signature);
    end if;
  end loop;
end
$functions$;

reset role;
revoke create on schema api,private from cirne_route_executor;
do $membership$
begin
  execute pg_catalog.format('revoke cirne_route_executor from %I granted by current_user',current_user);
end
$membership$;
commit;
