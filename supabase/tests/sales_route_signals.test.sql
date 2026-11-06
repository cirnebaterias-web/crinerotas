-- Story 4.14. Fresh synthetic identities and fixtures; every mutation rolls back.
begin;
select no_plan();
select has_function('api','get_sales_route_signals',array['uuid','uuid[]','uuid'],'bounded planner signal RPC exists');
select ok(has_function_privilege('authenticated','api.get_sales_route_signals(uuid,uuid[],uuid)','EXECUTE'),'authenticated can reach guarded RPC');
select ok(not has_function_privilege('anon','api.get_sales_route_signals(uuid,uuid[],uuid)','EXECUTE'),'anonymous cannot execute RPC');
select ok(not has_function_privilege('service_role','api.get_sales_route_signals(uuid,uuid[],uuid)','EXECUTE'),'service role cannot bypass RPC identity');
select ok(not has_function_privilege('authenticated','private.sales_client_context(uuid,uuid)','EXECUTE'),'context remains private after replacement');
select is((select pg_get_userbyid(proowner) from pg_proc where oid='api.get_sales_route_signals(uuid,uuid[],uuid)'::regprocedure),
 'cirne_route_executor','dedicated non-bypass executor owns RPC');
select ok((select prosecdef and provolatile='s' and proconfig @> array['search_path=""']
 from pg_proc where oid='api.get_sales_route_signals(uuid,uuid[],uuid)'::regprocedure),'reader is stable security definer with fixed empty search path');
do $$begin if exists(select 1 from private.sales_sources) then
 raise exception 'Synthetic suite requires an unconfigured sales source'; end if; end$$;

insert into auth.users(id,email,raw_user_meta_data,created_at,updated_at)
select ('41400000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'sales414-'||n||'@isolated.invalid',
 jsonb_build_object('synthetic',true),now(),now() from generate_series(1,5) n;
insert into api.user_profiles(id,display_name)
select ('41400000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'Sales414 synthetic actor '||n from generate_series(1,5) n;
-- 1/2 managers, 3/4 sellers, 5 administrator. Never use duplicated environment actors.
insert into api.user_role_assignments(user_id,role_id,assigned_by)
select ('41400000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 ('00000000-0000-4000-8000-'||lpad((case when n<=2 then 2 when n<=4 then 1 else 3 end)::text,12,'0'))::uuid,
 '41400000-0000-4000-8000-000000000005'::uuid from generate_series(1,5) n;
insert into api.user_seller_scopes(manager_user_id,seller_user_id) values
 ('41400000-0000-4000-8000-000000000001','41400000-0000-4000-8000-000000000003'),
 ('41400000-0000-4000-8000-000000000002','41400000-0000-4000-8000-000000000004');
insert into api.clients(id,external_reference,name,address,status,archived_at)
select ('41410000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'4141'||lpad(n::text,10,'0'),
 'Sales414 client '||n,'Synthetic address',case when n in(5,6) then 'inactive' else 'active' end,
 case when n=6 then now() else null end from generate_series(1,8) n;
insert into api.client_seller_scopes(client_id,seller_id,assigned_by)
select id,case when external_reference='41410000000004' then '41400000-0000-4000-8000-000000000004'::uuid
 else '41400000-0000-4000-8000-000000000003'::uuid end,'41400000-0000-4000-8000-000000000001'::uuid
 from api.clients where id between '41410000-0000-4000-8000-000000000001' and '41410000-0000-4000-8000-000000000008';
select (now() at time zone 'America/Sao_Paulo')::date as reference_date,
 date_trunc('month',now() at time zone 'America/Sao_Paulo')::date as month_start,
 (date_trunc('month',now() at time zone 'America/Sao_Paulo')-interval '11 months')::date as history_start,
 (date_trunc('month',now() at time zone 'America/Sao_Paulo')-interval '6 months')::date as volume_start \gset
select count(*) as route_count from api.routes \gset
select count(*) as version_count from api.route_versions \gset

set local role authenticated;
select set_config('request.jwt.claim.sub','',true);
select set_config('request.jwt.claims','{}',true);
select throws_ok($$select api.get_sales_route_signals(null,null)$$,'P0001','FORBIDDEN','no authenticated identity is denied before inspecting arguments');
select set_config('request.jwt.claim.sub','41400000-0000-4000-8000-000000000003',true);
select throws_ok($$select api.get_sales_route_signals('41400000-0000-4000-8000-000000000003',array['41410000-0000-4000-8000-000000000001']::uuid[])$$,
 'P0001','FORBIDDEN','seller cannot use management signal batch');
select set_config('request.jwt.claim.sub','41400000-0000-4000-8000-000000000005',true);
select throws_ok($$select api.get_sales_route_signals('41400000-0000-4000-8000-000000000003',array['41410000-0000-4000-8000-000000000001']::uuid[])$$,
 'P0001','FORBIDDEN','administrator has no implicit commercial read');
select set_config('request.jwt.claim.sub','41400000-0000-4000-8000-000000000001',true);
select throws_ok($$select api.get_sales_route_signals('41400000-0000-4000-8000-000000000003',array['41410000-0000-4000-8000-000000000001']::uuid[])$$,
 'P0001','SALES_UNAVAILABLE','authorized batch without published source is unavailable, not fake zeros');
select throws_ok($$select api.get_client_sales_page('41410000-0000-4000-8000-000000000001')$$,
 'P0001','SALES_UNAVAILABLE','authorized detail uses same unavailable state');
select throws_ok($$select api.get_client_sales_page('41410000-0000-4000-8000-000000000004')$$,
 'P0001','NOT_FOUND','unauthorized detail does not reveal source availability');
select throws_ok($$select api.get_sales_route_signals('41400000-0000-4000-8000-000000000003',array['41410000-0000-4000-8000-000000000004']::uuid[])$$,
 'P0001','NOT_FOUND','unauthorized batch does not reveal source availability');
select throws_ok($$select api.get_sales_route_signals(null,array['41410000-0000-4000-8000-000000000001']::uuid[])$$,'P0001','VALIDATION_FAILED','null seller rejected');
select throws_ok($$select api.get_sales_route_signals('41400000-0000-4000-8000-000000000003',null)$$,'P0001','VALIDATION_FAILED','null batch rejected');
select throws_ok($$select api.get_sales_route_signals('41400000-0000-4000-8000-000000000003',array[]::uuid[])$$,'P0001','VALIDATION_FAILED','empty batch rejected');
select throws_ok($$select api.get_sales_route_signals('41400000-0000-4000-8000-000000000003',array[null]::uuid[])$$,'P0001','VALIDATION_FAILED','null member rejected');
select throws_ok($$select api.get_sales_route_signals('41400000-0000-4000-8000-000000000003',array['41410000-0000-4000-8000-000000000001','41410000-0000-4000-8000-000000000001']::uuid[])$$,
 'P0001','VALIDATION_FAILED','duplicate client rejected instead of silently deduplicated');
select throws_ok($$select api.get_sales_route_signals('41400000-0000-4000-8000-000000000003',array[['41410000-0000-4000-8000-000000000001']]::uuid[])$$,
 'P0001','VALIDATION_FAILED','multidimensional array is not a client list');
select throws_ok($$select api.get_sales_route_signals('41400000-0000-4000-8000-000000000004',array['41410000-0000-4000-8000-000000000004']::uuid[])$$,
 'P0001','FORBIDDEN','another seller outside current manager scope is denied');
reset role;

insert into private.sales_sources(source_key,scheduler_actor_id) values(repeat('7',64),'41400000-0000-4000-8000-000000000001');
do $membership$
begin execute format('grant cirne_route_executor to %I with inherit true,set true granted by current_user',current_user); end
$membership$;
create function pg_temp.sales414_hash(rows jsonb) returns text language sql security definer set search_path='' as $$
 select encode(extensions.digest(convert_to(string_agg(private.sales_row_hash(value),'' order by (value->>'sourceRow')::integer),'UTF8'),'sha256'),'hex')
 from jsonb_array_elements(rows);
$$;
create function pg_temp.sales414_publish(rows jsonb,request_key uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare begun jsonb; chunk jsonb; chunk_index integer:=0; total integer:=jsonb_array_length(rows);
begin
 begun:=api.begin_sales_sheet_sync(repeat('7',64),request_key::text);
 while chunk_index*1000<total loop
   select jsonb_agg(value order by ord) into chunk from jsonb_array_elements(rows) with ordinality item(value,ord)
     where ord>chunk_index*1000 and ord<=(chunk_index+1)*1000;
   perform api.stage_sales_sheet_sync((begun->>'runId')::uuid,(begun->>'leaseToken')::uuid,
     chunk_index,pg_temp.sales414_hash(chunk),chunk);
   chunk_index:=chunk_index+1;
 end loop;
 return api.publish_sales_sheet_sync((begun->>'runId')::uuid,(begun->>'leaseToken')::uuid,pg_temp.sales414_hash(rows),total,1);
end$$;
create temporary table sales414_input(source_row integer,client_number integer,sale_date date,kind text,volume integer,sku text);
insert into sales414_input values
 (2,1,:'history_start'::date-1,'sale',50,'OLD-OUTSIDE-12'),
 (3,1,:'history_start','sale',2,'START-12'),
 (4,1,:'volume_start'::date-1,'sale',100,'BEFORE-6'),
 (5,1,:'volume_start','sale',10,'START-6'),
 (6,1,:'volume_start','sale',5,'SAME-DAY'),
 (7,1,:'volume_start'::date+10,'sale',5,'OTHER-DAY'),
 (8,1,:'month_start'::date-1,'return',-30,'RETURN'),
 (9,1,:'month_start','sale',1000,'CURRENT-PARTIAL'),
 (10,1,:'reference_date'::date+1,'sale',2000,'FUTURE-ONLY'),
 (11,3,:'volume_start'::date+1,'return',-7,'RETURN-ONLY'),
 (12,4,:'volume_start'::date+1,'sale',777,'OTHER-CLIENT'),
 (13,7,(:'history_start'::date-interval '3 months')::date,'sale',9,'OLD-ONLY');
-- 2.2 billion units proves the aggregate does not overflow PostgreSQL int4.
insert into sales414_input select 100+n,8,:'volume_start'::date+2,'sale',1000000,'BIGINT-VOLUME' from generate_series(1,2200) n;
select jsonb_agg(jsonb_build_object('sourceRow',source_row,'externalKey','S414-'||source_row,
 'clientExternalReference','4141'||lpad(client_number::text,10,'0'),'invoiceNumber','NF-'||source_row,
 'saleDate',sale_date,'sku',sku,'productDescription','Synthetic battery','itemGroup','SLI','itemSubgroup','',
 'category','Leve','brand','Synthetic','line','','kind',kind,'volume',volume,
 'totalAmount',case when kind='return' then '-1.00' else '1.00' end) order by source_row) as rows from sales414_input \gset
set local role authenticated;
select set_config('request.jwt.claim.sub','41400000-0000-4000-8000-000000000001',true);
select pg_temp.sales414_publish((:'rows')::jsonb,'41420000-0000-4000-8000-000000000001') as published \gset
select is((:'published')::jsonb->>'sourceRowCount','2212','synthetic generation is complete, including large-volume facts');
select api.get_sales_route_signals('41400000-0000-4000-8000-000000000003',
 array['41410000-0000-4000-8000-000000000008','41410000-0000-4000-8000-000000000007','41410000-0000-4000-8000-000000000003',
 '41410000-0000-4000-8000-000000000002','41410000-0000-4000-8000-000000000001']::uuid[]) as signal_batch \gset
select is((:'signal_batch')::jsonb->>'generationId',(:'published')::jsonb->>'generationId','signals use current published generation');
select is((:'signal_batch')::jsonb->>'asOfDate',:'reference_date','reference is the server Sao Paulo civil date');
select is((:'signal_batch')::jsonb->>'sellerId','41400000-0000-4000-8000-000000000003','seller context is explicit');
select is((:'signal_batch')::jsonb->>'observedFrom',(:'published')::jsonb->>'observedMinDate','observed coverage remains source metadata');
select is((:'signal_batch')::jsonb->>'observedThrough',(:'published')::jsonb->>'observedMaxDate','future source coverage is not disguised as complete current coverage');
select ok((:'signal_batch')::jsonb->>'fetchedAt' is not null and (:'signal_batch')::jsonb->>'publishedAt' is not null,'capture and publication times accompany metrics');
select is(jsonb_array_length((:'signal_batch')::jsonb->'signals'),5,'all requested eligible clients returned including no purchases');
select is((select jsonb_agg(item->'client'->>'id') from jsonb_array_elements((:'signal_batch')::jsonb->'signals') item),
 '["41410000-0000-4000-8000-000000000001","41410000-0000-4000-8000-000000000002","41410000-0000-4000-8000-000000000003","41410000-0000-4000-8000-000000000007","41410000-0000-4000-8000-000000000008"]'::jsonb,
 'output is UUID ordered independent of request order');
select is((:'signal_batch')::jsonb->'signals'->0->>'lastPurchaseDate',:'month_start','future purchase and later return do not reset recency');
select is((:'signal_batch')::jsonb->'signals'->0->>'purchaseDayCount12','5','positive distinct days use twelve calendar months including current month');
select is((:'signal_batch')::jsonb->'signals'->0->>'intervalTotalDays12',(:'month_start'::date-:'history_start'::date)::text,'interval sum is max minus min of distinct purchase dates');
select is((:'signal_batch')::jsonb->'signals'->0->>'netVolume6','-10','signed six complete months include lower boundary and exclude current month');
select is((:'signal_batch')::jsonb->'signals'->1,
 jsonb_build_object('client',jsonb_build_object('id','41410000-0000-4000-8000-000000000002','name','Sales414 client 2'),
 'lastPurchaseDate',null,'purchaseDayCount12',0,'intervalTotalDays12',0,'netVolume6',0),'no-history client retained with explicit null and zero raw aggregates');
select is((:'signal_batch')::jsonb->'signals'->2->'lastPurchaseDate','null'::jsonb,'return-only client has no positive purchase');
select is((:'signal_batch')::jsonb->'signals'->2->>'purchaseDayCount12','0','return-only dates do not create purchase cadence');
select is((:'signal_batch')::jsonb->'signals'->2->>'netVolume6','-7','return-only history may have negative registered volume');
select is((:'signal_batch')::jsonb->'signals'->3->>'lastPurchaseDate',(:'history_start'::date-interval '3 months')::date::text,'last positive purchase uses whole available history');
select is((:'signal_batch')::jsonb->'signals'->3->>'purchaseDayCount12','0','old-only purchase is excluded from twelve-month cadence');
select is((:'signal_batch')::jsonb->'signals'->4->>'purchaseDayCount12','1','many rows on one day still mean one purchase date');
select is((:'signal_batch')::jsonb->'signals'->4->>'intervalTotalDays12','0','one date has no observed interval');
select is((:'signal_batch')::jsonb->'signals'->4->>'netVolume6','2200000000','signed aggregate does not overflow int4');
select ok((:'signal_batch')::text !~ 'clientExternalReference|externalKey|sourceKey|invoiceNumber|totalAmount|cost|414100000000',
 'signals do not expose documents, raw source keys, money, costs or another client facts');
select is(api.get_sales_route_signals('41400000-0000-4000-8000-000000000003',
 array['41410000-0000-4000-8000-000000000001']::uuid[],((:'published')::jsonb->>'id')::uuid)->'signals'->0,
 (:'signal_batch')::jsonb->'signals'->0,'explicit current generation produces same metric');
select throws_ok($$select api.get_sales_route_signals('41400000-0000-4000-8000-000000000003',array['41410000-0000-4000-8000-000000000001']::uuid[],
 '41420000-0000-4000-8000-000000000099')$$,'P0001','VERSION_CONFLICT','unknown or old generation cannot be mixed');
select api.get_client_sales_products('41410000-0000-4000-8000-000000000001',((:'published')::jsonb->>'id')::uuid) as products \gset
select is((:'products')::jsonb->>'asOfDate',(:'signal_batch')::jsonb->>'asOfDate','catalog carries same civil reference as signals');
select is((:'products')::jsonb->>'generationId',(:'signal_batch')::jsonb->>'generationId','catalog carries generation context');
select api.get_client_sales_page('41410000-0000-4000-8000-000000000001') as detail_before \gset
select is((:'products')::jsonb->>'clientVersion',(:'detail_before')::jsonb->>'clientVersion','catalog and detail pin the same current client version');
select ok(not exists(select 1 from jsonb_array_elements((:'products')::jsonb->'products') item where item->>'sku'='FUTURE-ONLY'),'future SKU is excluded from catalog');
set local timezone='Pacific/Kiritimati';
select is(api.get_sales_route_signals('41400000-0000-4000-8000-000000000003',array['41410000-0000-4000-8000-000000000001']::uuid[])->>'asOfDate',
 :'reference_date','session timezone cannot move commercial reference');
select throws_ok($$select api.get_sales_route_signals('41400000-0000-4000-8000-000000000003',array['41410000-0000-4000-8000-000000000001','41410000-0000-4000-8000-000000000004']::uuid[])$$,
 'P0001','NOT_FOUND','mixed authorized and outside client fails whole batch');
select throws_ok($$select api.get_sales_route_signals('41400000-0000-4000-8000-000000000003',array['41410000-0000-4000-8000-000000000001','41410000-0000-4000-8000-000000000099']::uuid[])$$,
 'P0001','NOT_FOUND','unknown client fails whole batch');
select throws_ok($$select api.get_sales_route_signals('41400000-0000-4000-8000-000000000003',array['41410000-0000-4000-8000-000000000005']::uuid[])$$,
 'P0001','NOT_FOUND','inactive client is not eligible for route signals');
select throws_ok($$select api.get_sales_route_signals('41400000-0000-4000-8000-000000000003',array['41410000-0000-4000-8000-000000000006']::uuid[])$$,
 'P0001','NOT_FOUND','archived client is not eligible for route signals');
select is(jsonb_array_length(api.get_client_sales_page('41410000-0000-4000-8000-000000000006')->'rows'),0,
 'archived client detail remains allowed when current scope permits it');
reset role;
update api.clients set external_reference='41419999999999' where id='41410000-0000-4000-8000-000000000001';
set local role authenticated;
select api.get_client_sales_page('41410000-0000-4000-8000-000000000001') as detail_changed \gset
select is((:'detail_changed')::jsonb->>'clientVersion',(((:'detail_before')::jsonb->>'clientVersion')::integer+1)::text,
 'changing the current client reference increments the pinned version');
select is(jsonb_array_length((:'detail_changed')::jsonb->'rows'),0,'detail re-resolves current document instead of reusing previous client facts');
select is(api.get_client_sales_products('41410000-0000-4000-8000-000000000001',((:'published')::jsonb->>'id')::uuid)->>'clientVersion',
 (:'detail_changed')::jsonb->>'clientVersion','changed client version propagates through product pagination context');
reset role;
update api.clients set external_reference='41410000000001' where id='41410000-0000-4000-8000-000000000001';

insert into api.clients(id,external_reference,name,address)
select ('41410000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'4141'||lpad(n::text,10,'0'),'Batch client '||n,'Synthetic address' from generate_series(100,149) n;
insert into api.client_seller_scopes(client_id,seller_id,assigned_by)
select ('41410000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'41400000-0000-4000-8000-000000000003'::uuid,
 '41400000-0000-4000-8000-000000000001'::uuid from generate_series(100,149) n;
select array_agg(('41410000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid) as fifty from generate_series(100,149) n \gset
select array_agg(('41410000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid) as fifty_one from generate_series(100,150) n \gset
set local role authenticated;
select is(jsonb_array_length(api.get_sales_route_signals('41400000-0000-4000-8000-000000000003',:'fifty'::uuid[])->'signals'),50,'exact maximum batch is complete');
select throws_ok(format('select api.get_sales_route_signals(%L,%L::uuid[])','41400000-0000-4000-8000-000000000003',:'fifty_one'),
 'P0001','VALIDATION_FAILED','over-limit batch fails rather than truncates');
reset role;

update api.user_profiles set status='inactive',blocked_at=now() where id='41400000-0000-4000-8000-000000000001';
set local role authenticated;
select throws_ok($$select api.get_sales_route_signals('41400000-0000-4000-8000-000000000003',array['41410000-0000-4000-8000-000000000001']::uuid[])$$,
 'P0001','FORBIDDEN','manager blocked after login loses read');
reset role;
update api.user_profiles set status='active',blocked_at=null where id='41400000-0000-4000-8000-000000000001';
delete from api.role_permissions where role_id='00000000-0000-4000-8000-000000000002' and permission_code='sales.read_client';
set local role authenticated;
select throws_ok($$select api.get_sales_route_signals('41400000-0000-4000-8000-000000000003',array['41410000-0000-4000-8000-000000000001']::uuid[])$$,
 'P0001','FORBIDDEN','sales capability revocation is checked on every read');
reset role;
insert into api.role_permissions(role_id,permission_code) values('00000000-0000-4000-8000-000000000002','sales.read_client');
delete from api.role_permissions where role_id='00000000-0000-4000-8000-000000000002' and permission_code='route.plan_scoped';
set local role authenticated;
select throws_ok($$select api.get_sales_route_signals('41400000-0000-4000-8000-000000000003',array['41410000-0000-4000-8000-000000000001']::uuid[])$$,
 'P0001','FORBIDDEN','planning capability independently required');
reset role;
insert into api.role_permissions(role_id,permission_code) values('00000000-0000-4000-8000-000000000002','route.plan_scoped');
update api.user_profiles set status='inactive' where id='41400000-0000-4000-8000-000000000003';
set local role authenticated;
select throws_ok($$select api.get_sales_route_signals('41400000-0000-4000-8000-000000000003',array['41410000-0000-4000-8000-000000000001']::uuid[])$$,
 'P0001','FORBIDDEN','inactive current seller is denied');
reset role;
update api.user_profiles set blocked_at=now() where id='41400000-0000-4000-8000-000000000003';
set local role authenticated;
select throws_ok($$select api.get_sales_route_signals('41400000-0000-4000-8000-000000000003',array['41410000-0000-4000-8000-000000000001']::uuid[])$$,
 'P0001','FORBIDDEN','blocked current seller is denied');
reset role;
update api.user_profiles set status='active',blocked_at=null where id='41400000-0000-4000-8000-000000000003';
update api.user_role_assignments set revoked_at=now() where user_id='41400000-0000-4000-8000-000000000003';
set local role authenticated;
select throws_ok($$select api.get_sales_route_signals('41400000-0000-4000-8000-000000000003',array['41410000-0000-4000-8000-000000000001']::uuid[])$$,
 'P0001','FORBIDDEN','revoked seller role is removed from current manager scope even when its profile stays active');
reset role;
update api.user_role_assignments set revoked_at=null where user_id='41400000-0000-4000-8000-000000000003';
update api.user_seller_scopes set revoked_at=now() where manager_user_id='41400000-0000-4000-8000-000000000001';
set local role authenticated;
select throws_ok($$select api.get_sales_route_signals('41400000-0000-4000-8000-000000000003',array['41410000-0000-4000-8000-000000000001']::uuid[])$$,
 'P0001','FORBIDDEN','manager-to-seller revocation removes signal access');
reset role;
update api.user_seller_scopes set revoked_at=null where manager_user_id='41400000-0000-4000-8000-000000000001';
update api.client_seller_scopes set revoked_at=now() where client_id='41410000-0000-4000-8000-000000000001';
set local role authenticated;
select throws_ok($$select api.get_sales_route_signals('41400000-0000-4000-8000-000000000003',array['41410000-0000-4000-8000-000000000001']::uuid[])$$,
 'P0001','NOT_FOUND','client scope revoked after previous read denies whole batch');
reset role;
insert into api.client_seller_scopes(client_id,seller_id,assigned_by) values
 ('41410000-0000-4000-8000-000000000001','41400000-0000-4000-8000-000000000004','41400000-0000-4000-8000-000000000002');
set local role authenticated;
select set_config('request.jwt.claim.sub','41400000-0000-4000-8000-000000000002',true);
select is(api.get_sales_route_signals('41400000-0000-4000-8000-000000000004',array['41410000-0000-4000-8000-000000000001']::uuid[])->'signals'->0->>'netVolume6',
 '-10','new current portfolio reads unchanged historical facts');
reset role;
update api.client_seller_scopes set revoked_at=now() where client_id='41410000-0000-4000-8000-000000000001' and seller_id='41400000-0000-4000-8000-000000000004';
update api.client_seller_scopes set revoked_at=null where client_id='41410000-0000-4000-8000-000000000001' and seller_id='41400000-0000-4000-8000-000000000003';
insert into api.user_role_assignments(user_id,role_id,assigned_by) values
 ('41400000-0000-4000-8000-000000000005','00000000-0000-4000-8000-000000000002','41400000-0000-4000-8000-000000000005');
set local role authenticated;
select set_config('request.jwt.claim.sub','41400000-0000-4000-8000-000000000005',true);
select throws_ok($$select api.get_sales_route_signals('41400000-0000-4000-8000-000000000003',array['41410000-0000-4000-8000-000000000001']::uuid[])$$,
 'P0001','FORBIDDEN','administrator plus manager still cannot bypass absent managerial scope');
reset role;

update private.sales_sources set scheduler_actor_id=null where source_key=repeat('7',64);
set local role authenticated;
select set_config('request.jwt.claim.sub','41400000-0000-4000-8000-000000000001',true);
select is(api.get_sales_route_signals('41400000-0000-4000-8000-000000000003',array['41410000-0000-4000-8000-000000000001']::uuid[])->'signals'->0->>'netVolume6',
 '-10','revoked importer does not revoke a valid reader of published history');
reset role;
update private.sales_sources set scheduler_actor_id='41400000-0000-4000-8000-000000000001' where source_key=repeat('7',64);
-- Corrected source has one current record: no merge with preserved older generation.
select jsonb_build_array(((:'rows')::jsonb->0)||jsonb_build_object('saleDate',:'volume_start','volume',4)) as corrected_rows \gset
set local role authenticated;
select pg_temp.sales414_publish((:'corrected_rows')::jsonb,'41420000-0000-4000-8000-000000000002') as corrected \gset
select is(api.get_sales_route_signals('41400000-0000-4000-8000-000000000003',array['41410000-0000-4000-8000-000000000001']::uuid[])->'signals'->0->>'netVolume6',
 '4','next generation reflects corrections and source removals, not an accumulated merge');
select throws_ok(format('select api.get_sales_route_signals(%L,%L::uuid[],%L)',
 '41400000-0000-4000-8000-000000000003','{41410000-0000-4000-8000-000000000001}',(:'published')::jsonb->>'id'),
 'P0001','VERSION_CONFLICT','previously read generation conflicts after publication');
reset role;
select is((select count(*)::integer from private.sales_snapshot_lines where run_id=((:'published')::jsonb->>'id')::uuid),2212,'previous snapshot facts are retained');
select is((select count(*)::text from api.routes),:'route_count','reading signals never creates or publishes routes');
select is((select count(*)::text from api.route_versions),:'version_count','reading signals never revises route composition');
select * from finish();
rollback;
