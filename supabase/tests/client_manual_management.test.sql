begin;
select no_plan();

select has_table('private','client_management_commands','manual command results stay private');
select has_column('api','clients','lock_version','clients expose an optimistic version');
select has_column('api','client_seller_scopes','managed_by_manual_maintenance','seller scope provenance is explicit');
select has_function('api','create_client',array['jsonb','uuid','text'],'narrow create wrapper exists');
select has_function('api','get_client',array['uuid'],'narrow detail wrapper exists');
select has_function('api','update_client',array['uuid','jsonb','uuid','text'],'narrow update wrapper exists');
select has_function('api','list_management_clients',array['text','integer','integer'],
  'searchable paginated management list exists');
select ok(has_function_privilege('authenticated','api.create_client(jsonb,uuid,text)','EXECUTE'),'authenticated may call the authorized create wrapper');
select ok(has_function_privilege('authenticated','api.list_management_clients(text,integer,integer)','EXECUTE'),
  'authenticated may call the authorized management list');
select ok(not has_table_privilege('authenticated','private.client_management_commands','SELECT'),'browser cannot read idempotency records directly');
select ok(not has_table_privilege('authenticated','private.audit_events','SELECT'),'browser cannot read audit rows directly');
do $grant_normalizer_owner$
begin
  execute pg_catalog.format('grant cirne_route_executor to %I with set true granted by current_user', current_user);
end
$grant_normalizer_owner$;
set local role cirne_route_executor;
select is(private.normalize_client_external_reference(E'\t cliente\nmanual \t'), 'CLIENTE MANUAL',
  'database normalization trims after collapsing all whitespace');
reset role;
do $revoke_normalizer_owner$
begin
  execute pg_catalog.format('revoke cirne_route_executor from %I granted by current_user', current_user);
end
$revoke_normalizer_owner$;

select id as manager from auth.users where raw_user_meta_data->>'actorKey'='manager_a' \gset
select id as administrator from auth.users where raw_user_meta_data->>'actorKey'='administrator' \gset
select id as seller_a from auth.users where raw_user_meta_data->>'actorKey'='seller_a' \gset
select id as seller_b from auth.users where raw_user_meta_data->>'actorKey'='seller_b' \gset
select id as blocked from auth.users where raw_user_meta_data->>'actorKey'='blocked' \gset
select email as seller_a_email from auth.users where id=:'seller_a' \gset
select email as seller_b_email from auth.users where id=:'seller_b' \gset

insert into api.user_seller_scopes(manager_user_id,seller_user_id)
values(:'manager',:'seller_b')
on conflict (manager_user_id,seller_user_id) where revoked_at is null do nothing;

with inserted as (
  insert into api.clients (external_reference,name,address,portfolio_reference,status)
  select 'PAGE-QA-' || lpad(item::text,3,'0'),
    'Página QA ' || lpad(item::text,3,'0'),
    'Rua Paginação ' || item,
    'CARTEIRA-PAGE-QA',
    'active'
  from generate_series(1,105) item
  returning id
)
insert into api.client_seller_scopes (client_id,seller_id,assigned_by,managed_by_manual_maintenance)
select id, :'seller_a', :'manager', true from inserted;

set local role authenticated;
select set_config('request.jwt.claim.sub',:'manager',true);
select is((api.list_management_clients('PAGE-QA-',1,25)->'pagination'->>'totalCount')::integer,105,
  'search counts all authorized matches beyond the first hundred');
select is(jsonb_array_length(api.list_management_clients('PAGE-QA-',5,25)->'clients'),5,
  'fifth page exposes authorized clients beyond the first hundred');
select is(api.list_management_clients('PAGE-QA-',5,25)->'pagination'->>'totalPages','5',
  'pagination reports the last page');
select is(api.list_management_clients('PAGE-QA-',5,25)->'pagination'->>'hasPrevious','true',
  'last page reports a previous page');
select is(api.list_management_clients('PAGE-QA-',5,25)->'pagination'->>'hasNext','false',
  'last page does not report another page');
select is(jsonb_array_length(api.list_management_clients('PAGE-QA-105',1,25)->'clients'),1,
  'server-side search locates the client after the first hundred');
reset role;

select jsonb_build_object(
  'schemaVersion',1,'externalReference','12.345.678/0001-90','name','Cliente Manual TESTE',
  'address','Rua Manual 10','latitude',null,'longitude',null,'portfolioReference','CARTEIRA-MANUAL',
  'sellerEmail',:'seller_a_email','status','active'
) as create_command \gset

set local role authenticated;
select set_config('request.jwt.claim.sub',:'seller_a',true);
select throws_ok(format('select api.create_client(%L::jsonb,%L::uuid)',(:'create_command')::text,
  '32000000-0000-4000-8000-000000000001'),'P0001','FORBIDDEN','seller cannot create a client');
select set_config('request.jwt.claim.sub',:'blocked',true);
select throws_ok(format('select api.create_client(%L::jsonb,%L::uuid)',(:'create_command')::text,
  '32000000-0000-4000-8000-000000000002'),'P0001','FORBIDDEN','blocked user cannot create a client');
reset role;

delete from api.role_permissions
where role_id='00000000-0000-4000-8000-000000000002' and permission_code='clients.manage';
set local role authenticated;
select set_config('request.jwt.claim.sub',:'manager',true);
select throws_ok(format('select api.create_client(%L::jsonb,%L::uuid)',(:'create_command')::text,
  '32000000-0000-4000-8000-000000000003'),'P0001','FORBIDDEN','manager without clients.manage is denied');
reset role;
insert into api.role_permissions(role_id,permission_code)
values('00000000-0000-4000-8000-000000000002','clients.manage');

set local role authenticated;
select set_config('request.jwt.claim.sub',:'manager',true);
select api.create_client((:'create_command')::jsonb,'32000000-0000-4000-8000-000000000010','cli') as created \gset
select is((:'created')::jsonb->>'replayed','false','first create is not a replay');
select is((:'created')::jsonb->'client'->>'externalReference','12345678000190','formatted CNPJ uses shared normalization');
select is((:'created')::jsonb->'client'->>'version','1','manual client starts at version one');
select (:'created')::jsonb->'client'->>'id' as client_id \gset
select is(api.get_client(:'client_id'::uuid)->>'id',:'client_id','authorized manager reads the canonical client');
select is(api.create_client((:'create_command')::jsonb,'32000000-0000-4000-8000-000000000010','cli')->>'replayed',
  'true','same idempotency key and payload replays the canonical result');
select throws_ok(format('select api.create_client((%L::jsonb || %L::jsonb),%L::uuid)',
  (:'create_command')::text,'{"name":"Outro nome"}','32000000-0000-4000-8000-000000000010'),
  'P0001','IDEMPOTENCY_KEY_REUSED','same key with a different payload conflicts');
select throws_ok(format('select api.create_client(%L::jsonb,%L::uuid)',(:'create_command')::text,
  '32000000-0000-4000-8000-000000000011'),'P0001','VERSION_CONFLICT','duplicate external reference does not create another client');
reset role;

select is((select count(*)::integer from api.clients where external_reference='12345678000190'),1,'only one normalized client exists');
select is((select count(*)::integer from private.client_management_commands where client_id=:'client_id'),1,'replay creates one idempotency record');
select is((select count(*)::integer from private.audit_events where target_id=:'client_id' and action='client.manual.created.v1'),1,'replay creates one audit event');
select ok(exists(select 1 from api.client_seller_scopes where client_id=:'client_id' and seller_id=:'seller_a'
  and revoked_at is null and managed_by_manual_maintenance),'client and manual seller scope commit atomically');

select jsonb_build_object(
  'schemaVersion',1,'expectedVersion',1,'reason','Correção autorizada TESTE',
  'name','Cliente Manual Corrigido TESTE','address','Rua Manual 20','latitude',-5.79,'longitude',-35.21,
  'portfolioReference','CARTEIRA-B','sellerEmail',:'seller_b_email','status','archived'
) as update_command \gset
set local role authenticated;
select set_config('request.jwt.claim.sub',:'manager',true);
select api.update_client(:'client_id'::uuid,(:'update_command')::jsonb,
  '32000000-0000-4000-8000-000000000020','web') as updated \gset
select is((:'updated')::jsonb->'client'->>'version','2','authorized correction advances the optimistic version');
select is((:'updated')::jsonb->'client'->>'status','archived','authorized correction archives the client');
select throws_ok(format('select api.update_client(%L::uuid,%L::jsonb,%L::uuid)',:'client_id',
  (:'update_command')::text,'32000000-0000-4000-8000-000000000021'),
  'P0001','VERSION_CONFLICT','stale expected version cannot overwrite the client');
reset role;

select ok(exists(select 1 from api.client_seller_scopes where client_id=:'client_id' and seller_id=:'seller_a'
  and revoked_at is not null and managed_by_manual_maintenance),'seller change revokes the previous manual scope');
select ok(exists(select 1 from api.client_seller_scopes where client_id=:'client_id' and seller_id=:'seller_b'
  and revoked_at is null and managed_by_manual_maintenance),'seller change creates the new manual scope');
select ok((select archived_at is not null from api.clients where id=:'client_id'),'archiving records a timestamp instead of deleting');
select ok(exists(select 1 from private.audit_events where target_id=:'client_id' and action='client.manual.updated.v1'
  and before_data is not null and after_data is not null and reason='Correção autorizada TESTE'
  and origin='web'),'correction audit preserves before, after, reason and technical origin');

select jsonb_set(jsonb_set((:'update_command')::jsonb,'{expectedVersion}','2'::jsonb),'{status}','"active"'::jsonb) as reactivate_command \gset
set local role authenticated;
select set_config('request.jwt.claim.sub',:'manager',true);
select api.update_client(:'client_id'::uuid,(:'reactivate_command')::jsonb,
  '32000000-0000-4000-8000-000000000022','web') as reactivated \gset
select is((:'reactivated')::jsonb->'client'->>'status','active','reactivation is explicit and audited');
reset role;

select jsonb_build_object(
  'schemaVersion',1,'sourceName','precedencia-oficial.xlsx','sourceChecksum',repeat('d',64),
  'totalCount',1,'acceptedCount',1,'rejectedCount',0,
  'rows',jsonb_build_array(jsonb_build_object(
    'rowNumber',2,'externalReference','12.345.678/0001-90','name','Cliente Oficial TESTE',
    'address','Rua Oficial 30','latitude',null,'longitude',null,'portfolioReference','OFICIAL',
    'sellerEmail',:'seller_a_email','status','active')),'issues','[]'::jsonb
) as import_command \gset
set local role authenticated;
select set_config('request.jwt.claim.sub',:'manager',true);
select api.execute_client_import((:'import_command')::jsonb,'web') as imported \gset
reset role;
select is((:'imported')::jsonb->>'acceptedCount','1','approved official import updates the manual client');
select is((select count(*)::integer from api.clients where external_reference='12345678000190'),1,'official import does not duplicate the manual client');
select is((select name from api.clients where id=:'client_id'),'Cliente Oficial TESTE','official spreadsheet wins after authorized import');
select ok(not exists(select 1 from api.client_seller_scopes where client_id=:'client_id' and seller_id=:'seller_b'
  and revoked_at is null and managed_by_manual_maintenance),'official import revokes the superseded manual seller scope');
select ok(exists(select 1 from private.audit_events where target_id=:'client_id' and action='client.imported'),
  'official precedence appends import audit without erasing manual audit');

do $grant_route_executor$
begin
  execute pg_catalog.format('grant cirne_route_executor to %I with set true granted by current_user', current_user);
end
$grant_route_executor$;
set local role cirne_route_executor;
select throws_ok(format('delete from api.clients where id=%L::uuid',:'client_id'),
  'P0001','CLIENT_DELETE_FORBIDDEN','physical client deletion is rejected');
reset role;
do $revoke_route_executor$
begin
  execute pg_catalog.format('revoke cirne_route_executor from %I granted by current_user', current_user);
end
$revoke_route_executor$;

select * from finish();
rollback;
