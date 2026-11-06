-- Story 4.15 / ADR 007. Synthetic fixtures only; this entire suite rolls back.
begin;
select no_plan();

select has_table('private','product_catalog_sources','product catalog source configuration is private');
select has_table('private','product_catalog_snapshot_items','immutable product catalog items exist');
select has_table('private','product_catalog_sales_diagnostics','generation-pair diagnostics are private');
select ok((select relrowsecurity and relforcerowsecurity from pg_class
  where oid='private.product_catalog_sources'::regclass),'source binding forces RLS');
select ok(not has_table_privilege('authenticated','private.product_catalog_snapshot_items',
  'SELECT,INSERT,UPDATE,DELETE'),'browser cannot access catalog evidence directly');
select ok(not has_table_privilege('service_role','private.product_catalog_sources',
  'SELECT,INSERT,UPDATE,DELETE'),'service role cannot provision the private source');
select ok(not has_function_privilege('anon','api.begin_product_catalog_sync(text,text,text)','EXECUTE'),
  'anonymous cannot begin product catalog sync');
select ok(not has_function_privilege('service_role','private.product_catalog_source_identity(text)','EXECUTE'),
  'source authority helper is not callable through service role');
select is((select proargnames from pg_proc where oid=
  'api.get_client_sales_catalog_context(uuid,uuid,uuid,text,date,integer)'::regprocedure),
  array['p_client_id','p_sales_snapshot_id','p_catalog_snapshot_id','p_catalog_state','p_as_of_date','p_client_version']::text[],
  'catalog context RPC argument names match the Supabase client contract');
select is((select proargnames from pg_proc where oid=
  'api.get_client_product_opportunities(uuid,uuid,uuid,date,integer,integer)'::regprocedure),
  array['p_client_id','p_sales_snapshot_id','p_catalog_snapshot_id','p_as_of_date','p_client_version','p_page']::text[],
  'opportunity RPC argument names match the Supabase client contract');
select is((select proargnames from pg_proc where oid=
  'api.get_client_product_catalog_matches(uuid,uuid,uuid,date,integer,text[])'::regprocedure),
  array['p_client_id','p_sales_snapshot_id','p_catalog_snapshot_id','p_as_of_date','p_client_version','p_factory_codes']::text[],
  'top-match RPC argument names match the Supabase client contract');
select ok(not has_column_privilege('cirne_route_executor','private.product_catalog_sources','sync_actor_id','UPDATE'),
  'executor cannot rebind the technical actor');
select ok(has_column_privilege('cirne_route_executor','private.product_catalog_sources','published_run_id','UPDATE'),
  'executor can atomically move only the published head');
select is((select count(*)::integer from api.role_permissions
  where permission_code='products.sync'),0,'products.sync allowlist starts empty');

select id as manager from auth.users where raw_user_meta_data->>'actorKey'='manager_a'
  order by created_at desc,id limit 1 \gset
select id as other_manager from auth.users where raw_user_meta_data->>'actorKey'='manager_e2e'
  order by created_at desc,id limit 1 \gset
select id as seller from auth.users where raw_user_meta_data->>'actorKey'='seller_a'
  and id in(select seller_user_id from api.user_seller_scopes
    where manager_user_id=:'manager' and revoked_at is null)
  order by created_at desc,id limit 1 \gset

insert into api.clients(id,external_reference,name,address) values
  ('41500000-0000-4000-8000-000000000001','41500000000001','Cliente catalogo TESTE','Endereco sintetico'),
  ('41500000-0000-4000-8000-000000000002','41500000000002','Cliente fora catalogo TESTE','Endereco sintetico');
insert into api.client_seller_scopes(client_id,seller_id,assigned_by)
  values('41500000-0000-4000-8000-000000000001',:'seller',:'manager');

do $membership$
begin execute format('grant cirne_route_executor to %I with inherit true,set true granted by current_user',current_user); end
$membership$;

-- A published synthetic sales generation makes the CRM readable independently
-- from product-catalog availability.
insert into private.sales_sources(source_key,scheduler_actor_id)
  values(repeat('7',64),:'manager');
set local role cirne_route_executor;
insert into private.sales_sync_runs(id,source_key,request_key,trigger,requested_by,lease_expires_at,status,
  content_hash,parser_version,source_row_count,staged_row_count,observed_min_date,observed_max_date,
  fetched_at,completed_at)
values('41500000-0000-4000-8000-000000000010',repeat('7',64),
  '41500000-0000-4000-8000-000000000010','manual',:'manager',clock_timestamp()+interval '1 hour',
  'published',repeat('7',64),1,3,3,'2026-01-10','2026-03-10',clock_timestamp(),clock_timestamp());
insert into private.sales_snapshot_lines(run_id,source_row,external_key,client_external_reference,
  invoice_number,sale_date,sku,product_description,item_group,item_subgroup,category,brand,line,kind,
  volume,total_amount,row_hash)
values
 ('41500000-0000-4000-8000-000000000010',2,'CAT-SALE-A','41500000000001','001','2026-01-10',
  'SKU-A','Descricao da venda A','SLI','','Leve','Marca venda','','sale',2,200.00,repeat('1',64)),
 ('41500000-0000-4000-8000-000000000010',3,'CAT-SALE-MISSING','41500000000001','002','2026-02-10',
  'SKU-MISSING','Descricao sem cadastro','SLI','','Leve','Marca venda','','sale',1,100.00,repeat('2',64)),
 ('41500000-0000-4000-8000-000000000010',4,'CAT-RETURN-A','41500000000001','003','2026-03-10',
  'SKU-A','Descricao da venda A','SLI','','Leve','Marca venda','','return',-1,-100.00,repeat('3',64));
update private.sales_sources set published_run_id='41500000-0000-4000-8000-000000000010';
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub',:'seller',true);
select api.get_client_sales_catalog_context('41500000-0000-4000-8000-000000000001') as unavailable \gset
select is((:'unavailable')::jsonb#>>'{catalog,status}','catalog_unavailable',
  'sales CRM distinguishes missing catalog from zero opportunities');
select is((:'unavailable')::jsonb->>'salesGenerationId','41500000-0000-4000-8000-000000000010',
  'sales generation remains readable without a catalog');
select ok(not ((:'unavailable')::jsonb ? 'reference'),'private client reference is not projected');
select api.get_client_product_opportunities('41500000-0000-4000-8000-000000000001',
  '41500000-0000-4000-8000-000000000010'::uuid,null::uuid,
  ((:'unavailable')::jsonb->>'asOfDate')::date,
  ((:'unavailable')::jsonb->>'clientVersion')::integer,1) as unavailable_products \gset
select is(jsonb_typeof((:'unavailable_products')::jsonb->'products'),'null',
  'unavailable opportunities are null, never a false empty list');
select set_config('request.jwt.claim.sub',:'manager',true);
select throws_ok($$select api.begin_product_catalog_sync(repeat('8',64),
  '41500000-0000-4000-8000-000000000001')$$,'P0001','FORBIDDEN',
  'missing products.sync and source binding deny manual sync');
reset role;

insert into private.product_catalog_sources(source_key,sync_actor_id) values(repeat('8',64),:'manager');
select throws_ok(format('insert into private.product_catalog_sources(source_key,sync_actor_id) values(%L,%L)',
  repeat('9',64),:'manager'),'23505',null,'singleton prevents ambiguous product sources');
insert into api.role_permissions(role_id,permission_code)
  select id,'products.sync' from api.roles where code='manager';

create function pg_temp.product_catalog_hash(rows jsonb) returns text language sql security definer as $$
  select encode(extensions.digest(convert_to(string_agg(private.product_catalog_row_hash(value),''
    order by (value->>'sourceRow')::integer),'UTF8'),'sha256'),'hex')
  from jsonb_array_elements(rows);
$$;

select jsonb_build_object('sourceRow',2,'factoryCode','SKU-A','cirneCode','CIR-A','category','Leve',
  'description','Bateria A','originalItem','Item A','baseSku','BASE-A','brand','Marca A',
  'technology','AGM','technologyAbbreviation','AGM','amperageAh','60','ccaA','500','voltageV','12',
  'positivePolePosition','Direito','weightKg','14.2','dimensionsAxCxLmm','190x242x175',
  'dimensionsCxLxAmm','242x175x190','marketAveragePrice','999.99',
  'commonApplications','Aplicacao sintetica') as row_a \gset
select is(private.product_catalog_row_hash((:'row_a')::jsonb),
  'a33b5cbba40fb561a1029d542a838fcf9ed39856ac3b75e92a60949948291528',
  'known Node JSON tuple hash matches SQL canonicalization');
select throws_ok(format('select private.product_catalog_row_hash(%L::jsonb)',
  (:'row_a')::jsonb||jsonb_build_object('factoryCode','SEM TAB')),
  'P0001','VALIDATION_FAILED','SEM TAB is rejected by the database boundary');
select throws_ok(format('select private.product_catalog_row_hash(%L::jsonb)',
  (:'row_a')::jsonb||jsonb_build_object('factoryCode',U&'A\0301')),
  'P0001','VALIDATION_FAILED','non-NFC product identity is rejected');
select throws_ok(format('select private.product_catalog_row_hash(%L::jsonb)',
  (:'row_a')::jsonb||jsonb_build_object('rawPrice',1)),
  'P0001','VALIDATION_FAILED','extra raw fields are rejected');

create temporary table product_catalog_fixture(source_row integer primary key,document jsonb not null,row_hash text not null);
insert into product_catalog_fixture
select n,document,private.product_catalog_row_hash(document)
from generate_series(2,28) n
cross join lateral(select (:'row_a')::jsonb||jsonb_build_object('sourceRow',n,
  'factoryCode',case when n=2 then 'SKU-A' else 'SKU-'||lpad((n-1)::text,4,'0') end,
  'cirneCode','CIR-'||n,'baseSku','BASE-'||n) as document) d;
select jsonb_agg(document order by source_row) as catalog_rows,
  encode(extensions.digest(convert_to(string_agg(row_hash,'' order by source_row),'UTF8'),'sha256'),'hex') as catalog_hash
from product_catalog_fixture \gset

set local role authenticated;
select set_config('request.jwt.claim.sub',:'other_manager',true);
select throws_ok($$select api.begin_product_catalog_sync(repeat('8',64),
  '41500000-0000-4000-8000-000000000001')$$,'P0001','FORBIDDEN',
  'another manager with the same role cannot bypass source/actor binding');
select throws_ok($$select api.get_client_sales_catalog_context(
  '41500000-0000-4000-8000-000000000001')$$,'P0001','NOT_FOUND',
  'manager without the seller scope cannot enumerate the client');
select set_config('request.jwt.claim.sub',:'manager',true);
select is(api.get_product_catalog_sync_status(repeat('8',64)),
  jsonb_build_object('latestRun',null,'lastPublishedRun',null),'configured empty status is explicit');
select api.begin_product_catalog_sync(repeat('8',64),'41500000-0000-4000-8000-000000000001') as begun \gset
select is((:'begun')::jsonb->>'replayed','false','manual intention acquires a lease');
select is(api.begin_product_catalog_sync(repeat('8',64),
  '41500000-0000-4000-8000-000000000001')->>'leaseToken',(:'begun')::jsonb->>'leaseToken',
  'lost begin response replays the same lease');
select throws_ok($$select api.begin_product_catalog_sync(repeat('8',64),
  '41500000-0000-4000-8000-000000000002')$$,'P0001','SYNC_BUSY',
  'concurrent intention cannot interleave one source');
select throws_ok(format('select api.stage_product_catalog_sync(%L,%L,0,%L,%L)',
  (:'begun')::jsonb->>'runId',(:'begun')::jsonb->>'leaseToken',repeat('0',64),:'catalog_rows'),
  'P0001','VERSION_CONFLICT','chunk hash is recomputed, not trusted');
select api.stage_product_catalog_sync(((:'begun')::jsonb->>'runId')::uuid,
  ((:'begun')::jsonb->>'leaseToken')::uuid,0,:'catalog_hash',(:'catalog_rows')::jsonb) as staged \gset
select is((:'staged')::jsonb->>'stagedCount','27','complete synthetic catalog staged');
select is(api.stage_product_catalog_sync(((:'begun')::jsonb->>'runId')::uuid,
  ((:'begun')::jsonb->>'leaseToken')::uuid,0,:'catalog_hash',(:'catalog_rows')::jsonb)->>'replayed',
  'true','lost stage response replays canonically');
select lives_ok($$select api.get_client_sales_catalog_context(
  '41500000-0000-4000-8000-000000000001')$$,
  'manager with the current seller scope can read the client context');
select api.publish_product_catalog_sync(((:'begun')::jsonb->>'runId')::uuid,
  ((:'begun')::jsonb->>'leaseToken')::uuid,:'catalog_hash',27,1) as published \gset
select is((:'published')::jsonb->>'status','published','whole catalog generation publishes atomically');
select is((:'published')::jsonb->>'sourceRowCount','27','published row count is verified');
select is(api.publish_product_catalog_sync(((:'begun')::jsonb->>'runId')::uuid,
  ((:'begun')::jsonb->>'leaseToken')::uuid,:'catalog_hash',27,1),(:'published')::jsonb,
  'lost publish response replays the canonical result');
reset role;

select is((select count(*)::integer from private.product_catalog_sales_diagnostics
  where catalog_run_id=((:'published')::jsonb->>'id')::uuid),1,
  'future sales SKU absent from the catalog receives one private diagnostic');
select is((select sku from private.product_catalog_sales_diagnostics
  where catalog_run_id=((:'published')::jsonb->>'id')::uuid),'SKU-MISSING',
  'diagnostic uses exact sales SKU without mutating facts');
select is((select market_average_price from private.product_catalog_snapshot_items
  where run_id=((:'published')::jsonb->>'id')::uuid and factory_code='SKU-A'),'999.99',
  'market price is retained only in private immutable evidence');
select is((select count(*)::integer from private.audit_events
  where target_id=((:'published')::jsonb->>'id')::uuid and action='products.published'),1,
  'one publication creates one bounded audit event');
set local role cirne_route_executor;
select throws_ok(format('update private.product_catalog_sync_runs set source_row_count=1 where id=%L',
  (:'published')::jsonb->>'id'),'P0001','VERSION_CONFLICT',
  'published generation metadata is immutable even to the restricted executor');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub',:'seller',true);
select throws_ok(format('select api.get_client_sales_catalog_context(%L,%L,null,%L,%L,%L)',
  '41500000-0000-4000-8000-000000000001',(:'unavailable')::jsonb->>'salesGenerationId',
  'catalog_unavailable',(:'unavailable')::jsonb->>'asOfDate',
  (:'unavailable')::jsonb->>'clientVersion'),'P0001','VERSION_CONFLICT',
  'a cursor that pinned catalog absence cannot adopt the first published catalog');
select api.get_client_sales_catalog_context('41500000-0000-4000-8000-000000000001') as context \gset
select is((:'context')::jsonb#>>'{catalog,status}','available','current official catalog is available');
select is((:'context')::jsonb#>>'{catalog,rowCount}','27','catalog metadata carries source coverage');
select ok((:'context')::jsonb ?& array['salesGenerationId','fetchedAt','publishedAt','observedFrom',
  'observedThrough','asOfDate','client','clientVersion','catalog'],'context pins all v2 read metadata');
select ok(position('marketAveragePrice' in (:'context')::text)=0 and position('999.99' in (:'context')::text)=0,
  'context never exposes market price');
select api.get_client_product_opportunities('41500000-0000-4000-8000-000000000001',
  ((:'context')::jsonb->>'salesGenerationId')::uuid,((:'context')::jsonb#>>'{catalog,generationId}')::uuid,
  ((:'context')::jsonb->>'asOfDate')::date,((:'context')::jsonb->>'clientVersion')::integer,1) as page_one \gset
select is((:'page_one')::jsonb->>'pageSize','25','opportunity projection uses fixed bounded pages');
select is((:'page_one')::jsonb->>'availability','available','available page has an explicit discriminator');
select is((:'page_one')::jsonb->>'totalCount','26','positive sale excludes SKU-A even after a return');
select is((:'page_one')::jsonb->>'totalPages','2','numbered pagination reports exact page count');
select is(jsonb_array_length((:'page_one')::jsonb->'products'),25,'first opportunity page is bounded');
select is((:'page_one')::jsonb#>>'{coverage,catalogProductCount}','27','coverage counts official catalog products');
select is((:'page_one')::jsonb#>>'{coverage,salesProductCount}','2','coverage counts distinct sales products');
select is((:'page_one')::jsonb#>>'{coverage,matchedSalesProductCount}','1','coverage reports exact code matches');
select is((:'page_one')::jsonb#>>'{coverage,missingSalesProductCount}','1','coverage reports unmatched sales codes');
select ok(position('marketAveragePrice' in (:'page_one')::text)=0 and position('999.99' in (:'page_one')::text)=0,
  'opportunity products never expose market price');
select api.get_client_product_opportunities('41500000-0000-4000-8000-000000000001',
  ((:'context')::jsonb->>'salesGenerationId')::uuid,((:'context')::jsonb#>>'{catalog,generationId}')::uuid,
  ((:'context')::jsonb->>'asOfDate')::date,((:'context')::jsonb->>'clientVersion')::integer,2) as page_two \gset
select is(jsonb_array_length((:'page_two')::jsonb->'products'),1,'final numbered page is complete');
select api.get_client_product_catalog_matches('41500000-0000-4000-8000-000000000001',
  ((:'context')::jsonb->>'salesGenerationId')::uuid,((:'context')::jsonb#>>'{catalog,generationId}')::uuid,
  ((:'context')::jsonb->>'asOfDate')::date,((:'context')::jsonb->>'clientVersion')::integer,
  array['SKU-A','SKU-MISSING']) as matches \gset
select is(jsonb_array_length((:'matches')::jsonb->'products'),1,
  'top enrichment returns only exact official matches');
select is((:'matches')::jsonb#>>'{products,0,factoryCode}','SKU-A','matched product uses factory code identity');
select ok(position('marketAveragePrice' in (:'matches')::text)=0 and position('999.99' in (:'matches')::text)=0,
  'top enrichment never exposes market price');
select throws_ok(format('select api.get_client_product_opportunities(%L,%L,%L,%L,%L,1)',
  '41500000-0000-4000-8000-000000000001','41500000-0000-4000-8000-000000000099',
  (:'context')::jsonb#>>'{catalog,generationId}',(:'context')::jsonb->>'asOfDate',
  (:'context')::jsonb->>'clientVersion'),'P0001','VERSION_CONFLICT',
  'wrong sales generation cannot mix with the catalog');
select throws_ok(format('select api.get_client_product_opportunities(%L,%L,%L,%L,%L,1)',
  '41500000-0000-4000-8000-000000000001',(:'context')::jsonb->>'salesGenerationId',
  '41500000-0000-4000-8000-000000000099',(:'context')::jsonb->>'asOfDate',
  (:'context')::jsonb->>'clientVersion'),'P0001','VERSION_CONFLICT',
  'wrong catalog generation cannot mix with sales');
select throws_ok($$select api.get_client_product_opportunities(
  '41500000-0000-4000-8000-000000000001','41500000-0000-4000-8000-000000000010',
  null,current_date,1,4001)$$,'P0001','VALIDATION_FAILED','page limit is enforced');
select throws_ok(format('select api.get_client_product_opportunities(%L,%L,%L,%L,%L,1)',
  '41500000-0000-4000-8000-000000000002',(:'context')::jsonb->>'salesGenerationId',
  (:'context')::jsonb#>>'{catalog,generationId}',(:'context')::jsonb->>'asOfDate',
  (:'context')::jsonb->>'clientVersion'),'P0001','NOT_FOUND',
  'seller cannot enumerate another client through catalog projections');
reset role;

-- Invalid duplicate capture fails without replacing the valid head.
select (:'row_a')::jsonb||jsonb_build_object('sourceRow',3) as duplicate_row \gset
select pg_temp.product_catalog_hash(jsonb_build_array((:'row_a')::jsonb)) as one_hash,
  pg_temp.product_catalog_hash(jsonb_build_array((:'duplicate_row')::jsonb)) as duplicate_hash \gset
set local role authenticated;
select set_config('request.jwt.claim.sub',:'manager',true);
select api.begin_product_catalog_sync(repeat('8',64),'41500000-0000-4000-8000-000000000003') as duplicate_run \gset
select api.stage_product_catalog_sync(((:'duplicate_run')::jsonb->>'runId')::uuid,
  ((:'duplicate_run')::jsonb->>'leaseToken')::uuid,0,:'one_hash',jsonb_build_array((:'row_a')::jsonb));
select throws_ok(format('select api.stage_product_catalog_sync(%L,%L,1,%L,%L)',
  (:'duplicate_run')::jsonb->>'runId',(:'duplicate_run')::jsonb->>'leaseToken',:'duplicate_hash',
  jsonb_build_array((:'duplicate_row')::jsonb)),'P0001','VALIDATION_FAILED',
  'duplicate factory code across chunks rejects the capture');
select api.fail_product_catalog_sync(((:'duplicate_run')::jsonb->>'runId')::uuid,
  ((:'duplicate_run')::jsonb->>'leaseToken')::uuid,'VALIDATION_FAILED') as failed \gset
select is(api.get_product_catalog_sync_status(repeat('8',64))->'lastPublishedRun'->>'id',
  (:'published')::jsonb->>'id','failed capture preserves the previous head');
reset role;

-- A correction/removal becomes a new head while the former generation remains.
select jsonb_build_array((:'row_a')::jsonb,
  (:'row_a')::jsonb||jsonb_build_object('sourceRow',3,'factoryCode','SKU-0002','description','Bateria corrigida'))
  as corrected_rows \gset
select pg_temp.product_catalog_hash((:'corrected_rows')::jsonb) as corrected_hash \gset
set local role authenticated;
select set_config('request.jwt.claim.sub',:'manager',true);
select api.begin_product_catalog_sync(repeat('8',64),'41500000-0000-4000-8000-000000000004') as corrected_run \gset
select api.stage_product_catalog_sync(((:'corrected_run')::jsonb->>'runId')::uuid,
  ((:'corrected_run')::jsonb->>'leaseToken')::uuid,0,:'corrected_hash',(:'corrected_rows')::jsonb);
select api.publish_product_catalog_sync(((:'corrected_run')::jsonb->>'runId')::uuid,
  ((:'corrected_run')::jsonb->>'leaseToken')::uuid,:'corrected_hash',2,1) as corrected \gset
reset role;
select is((select count(*)::integer from private.product_catalog_snapshot_items
  where run_id=((:'published')::jsonb->>'id')::uuid),27,'previous generation remains immutable');
select is((select count(*)::integer from private.product_catalog_snapshot_items
  where run_id=((:'corrected')::jsonb->>'id')::uuid),2,'new generation reflects removals');
select is((select description from private.product_catalog_snapshot_items
  where run_id=((:'corrected')::jsonb->>'id')::uuid and factory_code='SKU-0002'),'Bateria corrigida',
  'new generation reflects corrections');

set local role authenticated;
select set_config('request.jwt.claim.sub',:'seller',true);
select throws_ok(format('select api.get_client_sales_catalog_context(%L,%L,%L,%L,%L,%L)',
  '41500000-0000-4000-8000-000000000001',(:'context')::jsonb->>'salesGenerationId',
  (:'context')::jsonb#>>'{catalog,generationId}','available',(:'context')::jsonb->>'asOfDate',
  (:'context')::jsonb->>'clientVersion'),'P0001','VERSION_CONFLICT',
  'old catalog page context conflicts after head replacement');
reset role;

-- Current authorization is always revalidated; history never grants access.
update api.client_seller_scopes set revoked_at=clock_timestamp()
  where client_id='41500000-0000-4000-8000-000000000001' and seller_id=:'seller';
set local role authenticated;
select set_config('request.jwt.claim.sub',:'seller',true);
select throws_ok($$select api.get_client_sales_catalog_context(
  '41500000-0000-4000-8000-000000000001')$$,'P0001','NOT_FOUND',
  'revoked client scope denies old catalog and sales generations');
reset role;

-- Revoking source binding or capability invalidates an already acquired lease.
set local role authenticated;
select set_config('request.jwt.claim.sub',:'manager',true);
select api.begin_product_catalog_sync(repeat('8',64),'41500000-0000-4000-8000-000000000005') as revoked_run \gset
reset role;
update private.product_catalog_sources set sync_actor_id=null;
set local role authenticated;
select throws_ok(format('select api.stage_product_catalog_sync(%L,%L,0,%L,%L)',
  (:'revoked_run')::jsonb->>'runId',(:'revoked_run')::jsonb->>'leaseToken',:'one_hash',
  jsonb_build_array((:'row_a')::jsonb)),'P0001','FORBIDDEN',
  'NULL actor binding revokes an acquired lease');
select throws_ok($$select api.get_product_catalog_sync_status(repeat('8',64))$$,
  'P0001','FORBIDDEN','revoked actor cannot read private operational status');
reset role;
update private.product_catalog_sources set sync_actor_id=:'manager';
delete from api.role_permissions where permission_code='products.sync';
set local role authenticated;
select throws_ok(format('select api.publish_product_catalog_sync(%L,%L,%L,1,1)',
  (:'revoked_run')::jsonb->>'runId',(:'revoked_run')::jsonb->>'leaseToken',:'one_hash'),
  'P0001','FORBIDDEN','revoked capability prevents publication');
reset role;

set local role cirne_route_executor;
select throws_ok($$update private.product_catalog_sources set sync_actor_id=gen_random_uuid()$$,
  '42501',null,'executor cannot rebind source directly');
select throws_ok($$insert into private.product_catalog_sources(source_key,sync_actor_id)
  values(repeat('a',64),gen_random_uuid())$$,'42501',null,'executor cannot provision another source');
with changed as (delete from private.product_catalog_snapshot_items returning 1)
select is((select count(*)::integer from changed),0,'immutable catalog items have no delete policy');
reset role;

do $membership$
begin execute format('revoke cirne_route_executor from %I granted by current_user',current_user); end
$membership$;
select * from finish();
rollback;
