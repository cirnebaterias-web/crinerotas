begin;
select no_plan();

select has_table('api','import_batches','import batch is persisted');
select has_table('private','import_batch_rows','row staging stays private');
select ok(not has_table_privilege('authenticated','private.import_batch_rows','SELECT'),'browser cannot read private rows directly');
select ok(has_function_privilege('authenticated','api.execute_client_import(jsonb,text)','EXECUTE'),'authenticated callers use the narrow import RPC');

select id as manager from auth.users where raw_user_meta_data->>'actorKey'='manager_a' \gset
select id as other_manager from auth.users where raw_user_meta_data->>'actorKey'='manager_e2e' \gset
select id as administrator from auth.users where raw_user_meta_data->>'actorKey'='administrator' \gset
select id as seller from auth.users where raw_user_meta_data->>'actorKey'='seller_a' \gset
select id as other_seller from auth.users where raw_user_meta_data->>'actorKey'='seller_b' \gset
select email as seller_email from auth.users where id=:'seller' \gset
select email as other_seller_email from auth.users where id=:'other_seller' \gset

insert into api.clients (id, external_reference, name, address)
values ('31100000-0000-4000-8000-000000000003','IMPORT-OUT-OF-SCOPE','Cliente Protegido TESTE','Rua Protegida 1');
insert into api.client_seller_scopes (client_id, seller_id, assigned_by)
values ('31100000-0000-4000-8000-000000000003',:'other_seller',:'administrator');

set local role authenticated;
select set_config('request.jwt.claim.sub',:'seller',true);
select throws_ok($$select api.execute_client_import('{"schemaVersion":1}'::jsonb)$$,'P0001','FORBIDDEN','seller cannot import clients');

select set_config('request.jwt.claim.sub',:'manager',true);
select throws_ok($$select api.execute_client_import('{}'::jsonb)$$,'P0001','VALIDATION_FAILED','malformed import command fails closed');
select is(api.validate_client_import_sellers(array[:'seller_email','missing@example.invalid']),
  '["missing@example.invalid"]'::jsonb,'validation reports seller email outside the active directory');
select is(api.validate_client_import_sellers(array[:'seller_email',:'other_seller_email']),
  jsonb_build_array(lower(:'other_seller_email')),'manager cannot target a seller outside their scope');

select jsonb_build_object(
  'schemaVersion',1,'sourceName','clientes-sinteticos.xlsx','sourceChecksum',repeat('a',64),
  'totalCount',2,'acceptedCount',1,'rejectedCount',1,
  'rows',jsonb_build_array(jsonb_build_object(
    'rowNumber',2,'externalReference','IMPORT-TEST-001','name','! Cliente Importado TESTE',
    'address','Rua Sintetica 1','latitude',-5.79,'longitude',-35.21,
    'portfolioReference','CARTEIRA-TESTE','sellerEmail',:'seller_email','status','active')),
  'issues',jsonb_build_array(jsonb_build_object(
    'rowNumber',3,'code','REQUIRED_FIELD','message','Campos obrigatorios ausentes.'))
) as import_command \gset

select api.execute_client_import((:'import_command')::jsonb, 'cli') as first_batch \gset
select is((:'first_batch')::jsonb->>'acceptedCount','1','valid row is accepted');
select is((:'first_batch')::jsonb->>'rejectedCount','1','invalid row is retained as a rejection');
select is((select item->>'status' from jsonb_array_elements(api.list_import_clients(50)) item
  where item->>'externalReference'='IMPORT-TEST-001'),'active','client is available for new routes');

select jsonb_build_object(
  'schemaVersion',1,'sourceName','clientes-fora-escopo.xlsx','sourceChecksum',repeat('c',64),
  'totalCount',1,'acceptedCount',1,'rejectedCount',0,
  'rows',jsonb_build_array(jsonb_build_object(
    'rowNumber',2,'externalReference','IMPORT-OUT-OF-SCOPE','name','Tentativa Indevida TESTE',
    'address','Rua Protegida 2','latitude',null,'longitude',null,
    'portfolioReference',null,'sellerEmail',:'seller_email','status','active')),
  'issues','[]'::jsonb
) as out_of_scope_command \gset
select api.execute_client_import((:'out_of_scope_command')::jsonb) as out_of_scope_batch \gset
select is((:'out_of_scope_batch')::jsonb->>'acceptedCount','0','manager cannot update a client outside their scope');
select is((:'out_of_scope_batch')::jsonb->'issues'->0->>'code','CLIENT_OUT_OF_SCOPE','out-of-scope row has an actionable rejection');
reset role;
select is((select name from api.clients where id='31100000-0000-4000-8000-000000000003'),'Cliente Protegido TESTE','out-of-scope client remains unchanged');
select ok(exists(select 1 from api.client_seller_scopes where client_id=(select id from api.clients where external_reference='IMPORT-TEST-001') and seller_id=:'seller' and revoked_at is null),'import maintains the explicit seller portfolio');
select ok(exists(select 1 from private.audit_events where target_id=(select id from api.clients where external_reference='IMPORT-TEST-001') and action='client.imported'),'client import is audited');
select is((select origin from private.audit_events where target_id=(select id from api.clients where external_reference='IMPORT-TEST-001') and action='client.imported' order by occurred_at limit 1),'cli','client import preserves its CLI origin');
set local role authenticated;
select set_config('request.jwt.claim.sub',:'manager',true);
select is(api.execute_client_import((:'import_command')::jsonb)->>'id',(:'first_batch')::jsonb->>'id','same checksum reuses the canonical batch');
select is(api.execute_client_import((:'import_command')::jsonb)->>'replayed','true','same checksum is marked as replay');

select jsonb_set(jsonb_set((:'import_command')::jsonb,'{sourceChecksum}',to_jsonb(repeat('b',64))),
  '{rows,0,status}','"archived"'::jsonb) - 'issues' || '{"issues":[],"totalCount":1,"acceptedCount":1,"rejectedCount":0}'::jsonb as archive_command \gset
select api.execute_client_import((:'archive_command')::jsonb);
select is((select item->>'status' from jsonb_array_elements(api.list_import_clients(50)) item
  where item->>'externalReference'='IMPORT-TEST-001'),'archived','explicit archived status inactivates the client');
select ok(exists(select 1 from jsonb_array_elements(api.list_import_clients(50)) item where item->>'externalReference'='IMPORT-TEST-001'),'authorized management can list the imported client');
select is(api.get_client_import(((:'first_batch')::jsonb->>'id')::uuid)->>'id',(:'first_batch')::jsonb->>'id','batch result remains queryable');

select set_config('request.jwt.claim.sub',:'other_manager',true);
select throws_ok(format('select api.get_client_import(%L::uuid)',(:'first_batch')::jsonb->>'id'),'P0001','NOT_FOUND','manager cannot read another manager import batch');
select set_config('request.jwt.claim.sub',:'administrator',true);
select is(api.get_client_import(((:'first_batch')::jsonb->>'id')::uuid)->>'id',(:'first_batch')::jsonb->>'id','administrator can inspect an import batch');

reset role;
select ok((select archived_at is not null from api.clients where external_reference='IMPORT-TEST-001'),'archive timestamp is preserved');
select * from finish();
rollback;
