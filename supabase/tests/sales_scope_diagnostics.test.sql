-- Story 4.13 AC7, synthetic transaction; no real spreadsheet or permanent fixture.
begin;
select no_plan();
select id as manager from auth.users where raw_user_meta_data->>'actorKey'='manager_a' order by created_at desc,id limit 1 \gset
select id as seller from auth.users where raw_user_meta_data->>'actorKey'='seller_a'
 and id in(select seller_user_id from api.user_seller_scopes where manager_user_id=:'manager' and revoked_at is null)
 order by created_at desc,id limit 1 \gset
select profile.id as other_seller from api.user_profiles profile
 where profile.status='active' and profile.blocked_at is null
 and exists(select 1 from api.user_role_assignments assignment join api.roles role on role.id=assignment.role_id
   where assignment.user_id=profile.id and assignment.revoked_at is null and role.code='seller')
 and not exists(select 1 from api.user_seller_scopes scope where scope.manager_user_id=:'manager'
   and scope.seller_user_id=profile.id and scope.revoked_at is null)
 and profile.id<>:'seller' order by profile.id limit 1 \gset
insert into api.clients(id,external_reference,name,address) values
 ('41310000-0000-4000-8000-000000000001','41310000000001','Sem carteira TESTE','Endereco sintetico'),
 ('41310000-0000-4000-8000-000000000002','41310000000002','Carteira revogada TESTE','Endereco sintetico'),
 ('41310000-0000-4000-8000-000000000003','41310000000003','Outra carteira TESTE','Endereco sintetico');
insert into api.client_seller_scopes(client_id,seller_id,assigned_by,revoked_at) values
 ('41310000-0000-4000-8000-000000000002',:'seller',:'manager',now()),
 ('41310000-0000-4000-8000-000000000003',:'other_seller',:'manager',null);
insert into private.sales_sources(source_key,scheduler_actor_id) values(repeat('6',64),:'manager');
do $membership$
begin execute format('grant cirne_route_executor to %I with inherit true,set true granted by current_user',current_user); end
$membership$;
select jsonb_agg(jsonb_build_object('sourceRow',n+1,'externalKey','SCOPE-'||n,
 'clientExternalReference','4131000000000'||n,'invoiceNumber','0001','saleDate','2026-10-01',
 'sku','SYNTHETIC-SKU','productDescription','Bateria teste','itemGroup','SLI','itemSubgroup','',
 'category','','brand','','line','','kind','sale','volume',1,'totalAmount','10.00') order by n) as rows
 from generate_series(1,4) n \gset
select encode(extensions.digest(convert_to(string_agg(private.sales_row_hash(value),'' order by (value->>'sourceRow')::integer),'UTF8'),'sha256'),'hex') as content_hash
 from jsonb_array_elements((:'rows')::jsonb) \gset
set local role authenticated;
select set_config('request.jwt.claim.sub',:'manager',true);
select api.begin_sales_sheet_sync(repeat('6',64),'41310000-0000-4000-8000-000000000001') as begun \gset
select api.stage_sales_sheet_sync(((:'begun')::jsonb->>'runId')::uuid,((:'begun')::jsonb->>'leaseToken')::uuid,0,:'content_hash',(:'rows')::jsonb);
select api.publish_sales_sheet_sync(((:'begun')::jsonb->>'runId')::uuid,((:'begun')::jsonb->>'leaseToken')::uuid,:'content_hash',4,1) as published \gset
select is((:'published')::jsonb->>'status','published','missing portfolio does not discard valid sales');
select is((:'published')::jsonb->>'sourceRowCount','4','all sales preserved including unlinked documents');
select is((:'published')::jsonb->>'unmatchedClientCount','1','unknown documents keep separate stable counter');
select is((:'published')::jsonb->>'issueCount','3','two missing current scopes plus one unknown row diagnosed');
select throws_ok($$select api.get_client_sales_page('41310000-0000-4000-8000-000000000001')$$,'P0001','NOT_FOUND','existing unassigned client remains invisible');
select throws_ok($$select api.get_client_sales_page('41310000-0000-4000-8000-000000000002')$$,'P0001','NOT_FOUND','revoked-only portfolio cannot authorize CRM');
select throws_ok($$select api.get_client_sales_page('41310000-0000-4000-8000-000000000003')$$,'P0001','NOT_FOUND','technical importer does not gain another portfolio');
select set_config('request.jwt.claim.sub',:'other_seller',true);
select is(jsonb_array_length(api.get_client_sales_page('41310000-0000-4000-8000-000000000003')->'rows'),1,'current outside seller can read its own sales');
reset role;
select is((select code from private.sales_sync_issues where run_id=((:'published')::jsonb->>'id')::uuid and source_row=2),'CLIENT_WITHOUT_ACTIVE_SCOPE','existing client without a link receives explicit issue');
select is((select code from private.sales_sync_issues where run_id=((:'published')::jsonb->>'id')::uuid and source_row=3),'CLIENT_WITHOUT_ACTIVE_SCOPE','revoked-only client receives explicit issue');
select is((select count(*)::integer from private.sales_sync_issues where run_id=((:'published')::jsonb->>'id')::uuid and source_row=4),0,'active portfolio outside importer is not invalid');
select is((select code from private.sales_sync_issues where run_id=((:'published')::jsonb->>'id')::uuid and source_row=5),'CLIENT_NOT_FOUND','unknown document has distinct issue');
select is((select count(*)::integer from private.sales_snapshot_lines where run_id=((:'published')::jsonb->>'id')::uuid),4,'diagnostics do not delete or skip facts');
select is((select count(*)::integer from api.client_seller_scopes where client_id in('41310000-0000-4000-8000-000000000001','41310000-0000-4000-8000-000000000002','41310000-0000-4000-8000-000000000003')),2,'import does not grant any portfolio link');
select is((select count(*)::integer from api.clients where external_reference='41310000000004'),0,'unknown document still does not create customer');
insert into api.client_seller_scopes(client_id,seller_id,assigned_by)
 values('41310000-0000-4000-8000-000000000001',:'seller',:'manager');
set local role authenticated;
select set_config('request.jwt.claim.sub',:'manager',true);
select is(api.publish_sales_sheet_sync(((:'begun')::jsonb->>'runId')::uuid,((:'begun')::jsonb->>'leaseToken')::uuid,:'content_hash',4,1),(:'published')::jsonb,'later portfolio assignment never rewrites terminal replay');
select api.begin_sales_sheet_sync(repeat('6',64),'41310000-0000-4000-8000-000000000002') as second_run \gset
select api.stage_sales_sheet_sync(((:'second_run')::jsonb->>'runId')::uuid,((:'second_run')::jsonb->>'leaseToken')::uuid,0,:'content_hash',(:'rows')::jsonb);
select api.publish_sales_sheet_sync(((:'second_run')::jsonb->>'runId')::uuid,((:'second_run')::jsonb->>'leaseToken')::uuid,:'content_hash',4,1) as second_published \gset
select is((:'second_published')::jsonb->>'issueCount','2','only new generation observes corrected current link');
select is((:'second_published')::jsonb->>'unmatchedClientCount','1','unknown count unchanged after portfolio fix');
reset role;
select is((select count(*)::integer from private.sales_sync_issues where run_id=((:'published')::jsonb->>'id')::uuid),3,'old generation diagnostics preserved for audit');
select is((select count(*)::integer from private.audit_events where target_id=((:'published')::jsonb->>'id')::uuid and action='sales.published'),1,'replay does not duplicate publication audit');
do $membership$
begin execute format('revoke cirne_route_executor from %I granted by current_user',current_user); end
$membership$;
select * from finish();
rollback;
