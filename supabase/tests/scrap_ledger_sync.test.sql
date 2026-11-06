begin;
select no_plan();
select has_table('private','scrap_ledger_runs','scrap ledger generations are private');
select ok(not has_table_privilege('authenticated','private.scrap_ledger_entries','SELECT,INSERT,UPDATE,DELETE'),'browser cannot access ledger rows directly');
select ok(not has_function_privilege('anon','api.publish_scrap_ledger_snapshot(text,text,jsonb,jsonb,text)','EXECUTE'),'anonymous cannot publish');
select ok(not has_function_privilege('authenticated','private.scrap_client_allowed(uuid)','EXECUTE'),'private client scope helper is not callable');

select id as manager from auth.users where raw_user_meta_data->>'actorKey'='manager_a' order by created_at desc limit 1 \gset
select id as seller from auth.users where raw_user_meta_data->>'actorKey'='seller_a' order by created_at desc limit 1 \gset
select id as seller_b from auth.users where raw_user_meta_data->>'actorKey'='seller_b' order by created_at desc limit 1 \gset
insert into api.clients(id,external_reference,name,address) values
 ('41800000-0000-4000-8000-000000000001','41800000000001','Cliente sucata TESTE','Endereco sintetico'),
 ('41800000-0000-4000-8000-000000000002','41800000000002','Cliente sem saldo TESTE','Endereco sintetico'),
 ('41800000-0000-4000-8000-000000000003','41800000000003','Cliente fora do escopo','Endereco sintetico');
insert into api.client_seller_scopes(client_id,seller_id,assigned_by) values
 ('41800000-0000-4000-8000-000000000001',:'seller',:'manager'),
 ('41800000-0000-4000-8000-000000000002',:'seller',:'manager'),
 ('41800000-0000-4000-8000-000000000003',:'seller_b',:'manager');
select jsonb_build_array(
 jsonb_build_object('sourceRow',5,'sequence','1','operation','debit','clientExternalReference','41800000000001','clientName','Cliente sucata TESTE','city','Natal','seller','Teste','invoiceNumber','1','occurredOn',(current_date-interval '30 days')::date,'sourceWeightKg','120.000','price','10,00','total','1200,00','signedWeightKg','-120.000','status','','settlementMethod','','duplicate','','commitmentTerm','','settlementTerm','','notes','','portfolioSeller','Teste','tradeName','Cliente','portfolioCity','Natal','groupName','','clientStatus','Ativo'),
 jsonb_build_object('sourceRow',6,'sequence','2','operation','credit','clientExternalReference','41800000000001','clientName','Cliente sucata TESTE','city','Natal','seller','Teste','invoiceNumber','2','occurredOn',(current_date-interval '10 days')::date,'sourceWeightKg','40.000','price','','total','','signedWeightKg','40.000','status','','settlementMethod','','duplicate','','commitmentTerm','','settlementTerm','','notes','','portfolioSeller','Teste','tradeName','Cliente','portfolioCity','Natal','groupName','','clientStatus','Ativo'),
 jsonb_build_object('sourceRow',7,'sequence','3','operation','debit','clientExternalReference','41800000000002','clientName','Cliente sem saldo TESTE','city','Natal','seller','Teste','invoiceNumber','3','occurredOn',current_date,'sourceWeightKg','10.000','price','','total','','signedWeightKg','-10.000','status','','settlementMethod','','duplicate','','commitmentTerm','','settlementTerm','','notes','','portfolioSeller','Teste','tradeName','Sem Saldo','portfolioCity','Natal','groupName','','clientStatus','Ativo'),
 jsonb_build_object('sourceRow',8,'sequence','4','operation','debit','clientExternalReference','41800000000003','clientName','Cliente fora do escopo','city','Natal','seller','Teste B','invoiceNumber','4','occurredOn',current_date,'sourceWeightKg','20.000','price','','total','','signedWeightKg','-20.000','status','','settlementMethod','','duplicate','','commitmentTerm','','settlementTerm','','notes','','portfolioSeller','Teste B','tradeName','Fora','portfolioCity','Natal','groupName','','clientStatus','Ativo')) as entries \gset
select jsonb_build_array(
 jsonb_build_object('sourceRow',5,'clientExternalReference','41800000000001','clientStatus','Ativo','groupName','','legalName','Razao Oficial Exclusiva','tradeName','Cliente','city','Natal','portfolioSeller','Teste','originalDebitsKg','120.000','obligationKg','120.000','creditsKg','40.000','balanceKg','-80.000','balanceStatus','Em débito','pendingSince',(current_date-interval '30 days')::date,'overdueDays',30,'overdueBand','Até 30','lastMovementOn',(current_date-interval '10 days')::date,'lastDebitOn',(current_date-interval '30 days')::date,'lastDebitWeightKg','120.000','lastCreditOn',(current_date-interval '10 days')::date,'lastCreditWeightKg','40.000','entryCount',2),
 jsonb_build_object('sourceRow',6,'clientExternalReference','41800000000003','clientStatus','Ativo','groupName','','legalName','Fora do Escopo LTDA','tradeName','Fora','city','Natal','portfolioSeller','Teste B','originalDebitsKg','20.000','obligationKg','20.000','creditsKg','0.000','balanceKg','-20.000','balanceStatus','Em débito','pendingSince',current_date,'overdueDays',0,'overdueBand','Atual','lastMovementOn',current_date,'lastDebitOn',current_date,'lastDebitWeightKg','20.000','lastCreditOn',null,'lastCreditWeightKg',null,'entryCount',1)) as balances \gset

set local role authenticated;
select set_config('request.jwt.claim.sub',:'seller',true);
select throws_ok(format('select api.publish_scrap_ledger_snapshot(%L,%L,%L,%L,%L)','41800000-0000-4000-8000-000000000001','manual',:'entries',:'balances',repeat('a',64)),'P0001','FORBIDDEN','seller cannot publish ledger');
select set_config('request.jwt.claim.sub',:'manager',true);
select api.publish_scrap_ledger_snapshot('41800000-0000-4000-8000-000000000001','manual',(:'entries')::jsonb,(:'balances')::jsonb,repeat('a',64)) as published \gset
select is((:'published')::jsonb->>'status','published','manager atomically publishes both tabs');
select is((:'published')::jsonb->>'entryCount','4','entry count preserved');
select is((:'published')::jsonb->>'balanceCount','2','balance count preserved');
select is(api.publish_scrap_ledger_snapshot('41800000-0000-4000-8000-000000000001','manual',(:'entries')::jsonb,(:'balances')::jsonb,repeat('a',64)),(:'published')::jsonb,'same request replays without duplicates');
select set_config('request.jwt.claim.sub',:'seller',true);
select api.get_client_scrap_summary('41800000-0000-4000-8000-000000000001') as summary \gset
select is((:'summary')::jsonb->>'currentDebtKg','80.000','negative official balance is presented as positive current debt');
select is((:'summary')::jsonb->>'lastCollectionKg','40.000','last official credit is the last collection');
select throws_ok($$select api.get_scrap_ledger_analytics('balances','',1)$$,'P0001','FORBIDDEN','seller cannot open manager analytics');
select set_config('request.jwt.claim.sub',:'manager',true);
select api.begin_scrap_ledger_sync('41800000-0000-4000-8000-000000000010','manual') as empty_run \gset
select throws_ok(format('select api.publish_staged_scrap_ledger(%L,%L,0,0)',(:'empty_run')::jsonb->>'id',repeat('b',64)),'P0001','VERSION_CONFLICT','staged publication rejects empty tabs');
select is((api.fail_scrap_ledger_sync(((:'empty_run')::jsonb->>'id')::uuid,'SOURCE_INVALID')->>'status'),'failed','failed acquisition or validation remains observable');
select is((api.get_scrap_ledger_analytics('balances','Oficial Exclusiva',1)->>'totalCount')::integer,1,'balance filter searches legal name');
select is((api.get_scrap_ledger_analytics('entries','Oficial Exclusiva',1)->>'totalCount')::integer,2,'history filter resolves legal name through the official balance row');
select is((api.get_scrap_ledger_analytics('entries','',1)->>'totalCount')::integer,3,'history keeps scoped movement without a balance row and excludes another portfolio');
select is((api.get_scrap_ledger_analytics('balances','',1)->>'totalCount')::integer,1,'manager analytics is limited to authorized portfolio');
select is((api.get_scrap_ledger_analytics('balances','418000',1)->>'totalCount')::integer,1,'balance filter searches normalized tax id');
select is((api.get_scrap_ledger_analytics('balances','Natal',1)->>'totalCount')::integer,0,'filter does not search city or unrelated fields');
select is(api.get_scrap_ledger_analytics('balances','418000',1)->'totals'->>'balance_kg','-80.000','balance totalizer follows the active filter');
select is(api.get_scrap_ledger_analytics('balances','418000',1)->'totals'->>'last_credit_weight_kg','40.000','last credit weight totalizer follows the active filter');
select is(api.get_scrap_ledger_analytics('entries','418000',1)->'totals'->>'signed_weight_kg','-90.000','history totalizer follows the active filter');
reset role;
select is((select count(*)::integer from private.scrap_ledger_runs where request_key='41800000-0000-4000-8000-000000000001'),1,'replay creates one immutable generation');
select is((select count(*)::integer from private.scrap_ledger_entries where generation_id=((:'published')::jsonb->>'id')::uuid),4,'replay does not duplicate entries');
select * from finish();
rollback;
