begin;
select no_plan();

select has_table('private','administration_commands','administration idempotency ledger exists');
select has_function('api','get_administration_snapshot',array[]::text[],
  'narrow administration snapshot exists');
select has_function('api','update_administration_user',array['uuid','jsonb','text'],
  'narrow administration mutation exists');
select ok(has_function_privilege('authenticated','api.get_administration_snapshot()','EXECUTE'),
  'authenticated callers may reach the authorized snapshot wrapper');
select ok(has_function_privilege('authenticated','api.update_administration_user(uuid,jsonb,text)','EXECUTE'),
  'authenticated callers may reach the authorized mutation wrapper');
select ok(not has_function_privilege('anon','api.get_administration_snapshot()','EXECUTE'),
  'anonymous callers cannot execute the administration snapshot');
select ok(not has_table_privilege('authenticated','private.administration_commands','SELECT'),
  'browser callers cannot read administration idempotency records');
select ok(not has_table_privilege('authenticated','private.audit_events','SELECT'),
  'browser callers cannot read the audit ledger directly');
select ok(not (select rolcanlogin or rolbypassrls or rolsuper from pg_catalog.pg_roles
  where rolname='cirne_administration_executor'),
  'administration executor cannot login, bypass RLS or become superuser');
select is((select pg_catalog.pg_get_userbyid(proowner) from pg_catalog.pg_proc
  where oid='api.get_administration_snapshot()'::regprocedure),'cirne_administration_executor',
  'snapshot is owned by the dedicated executor');
select is((select pg_catalog.pg_get_userbyid(proowner) from pg_catalog.pg_proc
  where oid='api.update_administration_user(uuid,jsonb,text)'::regprocedure),'cirne_administration_executor',
  'mutation is owned by the dedicated executor');

select id as administrator from auth.users where raw_user_meta_data->>'actorKey'='administrator' \gset
select id as manager from auth.users where raw_user_meta_data->>'actorKey'='manager_a' \gset
select id as seller_a from auth.users where raw_user_meta_data->>'actorKey'='seller_a' \gset
select id as seller_b from auth.users where raw_user_meta_data->>'actorKey'='seller_b' \gset
select id as logistics from auth.users where raw_user_meta_data->>'actorKey'='logistics_a' \gset
select id as blocked from auth.users where raw_user_meta_data->>'actorKey'='blocked' \gset

set local role authenticated;
select set_config('request.jwt.claim.sub',:'administrator',true);
select api.get_administration_snapshot() as administration_snapshot \gset
select is((:'administration_snapshot')::jsonb->>'schemaVersion','1','snapshot is explicitly versioned');
select ok(jsonb_array_length((:'administration_snapshot')::jsonb->'users') >= 6,
  'administrator receives the existing profile catalog');
select is((:'administration_snapshot')::jsonb->'parameters'->>'mutationAvailability',
  'blocked_pending_business_approval','parameter mutation remains blocked pending business approval');
select is((:'administration_snapshot')::jsonb->'parameters'->'blockers',
  '["AB-02", "AB-03", "AB-09"]'::jsonb,'parameter blockers are explicit');
select ok((:'administration_snapshot')::text not ilike '%@%'
  and (:'administration_snapshot')::text not ilike '%token%'
  and (:'administration_snapshot')::text not ilike '%password%',
  'snapshot excludes email, token and password material');
select ok((select bool_and((item ? 'id') and (item ? 'displayName') and (item ? 'roles')
  and (item ? 'sellerScopeIds') and (item ? 'updatedAt'))
  from jsonb_array_elements((:'administration_snapshot')::jsonb->'users') item),
  'every administration user has the minimal canonical projection');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub',:'manager',true);
select throws_ok('select api.get_administration_snapshot()','P0001','FORBIDDEN',
  'manager cannot read administration data');
select set_config('request.jwt.claim.sub',:'seller_a',true);
select throws_ok('select api.get_administration_snapshot()','P0001','FORBIDDEN',
  'seller cannot read administration data');
select set_config('request.jwt.claim.sub',:'logistics',true);
select throws_ok('select api.get_administration_snapshot()','P0001','FORBIDDEN',
  'logistics cannot read administration data');
select set_config('request.jwt.claim.sub',:'blocked',true);
select throws_ok('select api.get_administration_snapshot()','P0001','FORBIDDEN',
  'blocked actor cannot read administration data');
reset role;

select updated_at as manager_updated_at from api.user_profiles where id=:'manager' \gset
select jsonb_build_object(
  'schemaVersion',1,'expectedUpdatedAt',:'manager_updated_at'::timestamptz,
  'status','active','roles',jsonb_build_array('manager'),
  'sellerScopeIds',jsonb_build_array(:'seller_a'::uuid,:'seller_b'::uuid),
  'reason','Amplia\u00e7\u00e3o da carteira gerencial para valida\u00e7\u00e3o TESTE',
  'idempotencyKey','41000000-0000-4000-8000-000000000001'
) as manager_command \gset

set local role authenticated;
select set_config('request.jwt.claim.sub',:'administrator',true);
select api.update_administration_user(:'manager'::uuid,(:'manager_command')::jsonb,'cli') as manager_result \gset
select is((:'manager_result')::jsonb->>'replayed','false','first administration mutation is not a replay');
select is((:'manager_result')::jsonb->'user'->'roles','["manager"]'::jsonb,
  'mutation preserves the requested active role set');
select ok((:'manager_result')::jsonb->'user'->'sellerScopeIds' ? :'seller_a'
  and (:'manager_result')::jsonb->'user'->'sellerScopeIds' ? :'seller_b',
  'manager receives exactly the authorized seller scope additions');
select is(api.update_administration_user(:'manager'::uuid,(:'manager_command')::jsonb,'cli')->>'replayed',
  'true','same command replays its canonical result');
select throws_ok(format('select api.update_administration_user(%L::uuid,(%L::jsonb || %L::jsonb),%L)',
  :'manager',(:'manager_command')::text,'{"reason":"Outra justificativa administrativa v\u00e1lida TESTE"}','cli'),
  'P0001','IDEMPOTENCY_KEY_REUSED','same key with a different payload is rejected');
reset role;

select is((select count(*)::integer from private.administration_commands
  where actor_id=:'administrator' and idempotency_key='41000000-0000-4000-8000-000000000001'),1,
  'idempotent replay stores one command result');
select is((select count(*)::integer from private.audit_events where target_id=:'manager'
  and action='identity.access.updated.v1' and request_id='41000000-0000-4000-8000-000000000001'),1,
  'idempotent replay writes one audit event');
select ok(exists(select 1 from private.audit_events where target_id=:'manager'
  and action='identity.access.updated.v1' and before_data is not null and after_data is not null
  and reason='Amplia\u00e7\u00e3o da carteira gerencial para valida\u00e7\u00e3o TESTE' and origin='cli'),
  'audit preserves before, after, reason and origin');

update api.user_profiles set status='inactive',blocked_at=statement_timestamp() where id=:'seller_b';
select updated_at as manager_scope_updated_at from api.user_profiles where id=:'manager' \gset
select jsonb_set(jsonb_set((:'manager_command')::jsonb,'{expectedUpdatedAt}',
  to_jsonb(:'manager_scope_updated_at'::timestamptz)),
  '{idempotencyKey}','"41000000-0000-4000-8000-000000000006"'::jsonb) as preserve_scope_command \gset
set local role authenticated;
select set_config('request.jwt.claim.sub',:'administrator',true);
select api.update_administration_user(:'manager'::uuid,(:'preserve_scope_command')::jsonb,'web') as preserved_scope_result \gset
select ok((:'preserved_scope_result')::jsonb->'user'->'sellerScopeIds' ? :'seller_b',
  'an existing scope remains visible and valid after its seller becomes inactive');
reset role;

select updated_at as manager_remove_scope_updated_at from api.user_profiles where id=:'manager' \gset
select jsonb_set(jsonb_set(jsonb_set((:'manager_command')::jsonb,'{expectedUpdatedAt}',
  to_jsonb(:'manager_remove_scope_updated_at'::timestamptz)),'{sellerScopeIds}',jsonb_build_array(:'seller_a'::uuid)),
  '{idempotencyKey}','"41000000-0000-4000-8000-000000000007"'::jsonb) as remove_inactive_scope_command \gset
set local role authenticated;
select set_config('request.jwt.claim.sub',:'administrator',true);
select api.update_administration_user(:'manager'::uuid,(:'remove_inactive_scope_command')::jsonb,'web') as removed_scope_result \gset
select ok(not ((:'removed_scope_result')::jsonb->'user'->'sellerScopeIds' ? :'seller_b'),
  'administrator can revoke the existing scope of an inactive seller');
select jsonb_set((:'preserve_scope_command')::jsonb,
  '{idempotencyKey}','"41000000-0000-4000-8000-000000000008"'::jsonb) as readd_inactive_scope_command \gset
select throws_ok(format('select api.update_administration_user(%L::uuid,%L::jsonb,%L)',
  :'manager',(:'readd_inactive_scope_command')::text,'web'),'P0001','VALIDATION_FAILED',
  'an inactive seller cannot be added as a new manager scope');
reset role;
update api.user_profiles set status='active',blocked_at=null where id=:'seller_b';

select jsonb_set((:'manager_command')::jsonb,
  '{idempotencyKey}','"41000000-0000-4000-8000-000000000002"'::jsonb) as stale_command \gset
set local role authenticated;
select set_config('request.jwt.claim.sub',:'administrator',true);
select throws_ok(format('select api.update_administration_user(%L::uuid,%L::jsonb,%L)',
  :'manager',(:'stale_command')::text,'web'),'P0001','VERSION_CONFLICT',
  'stale optimistic timestamp cannot overwrite a newer profile');
select throws_ok(format('select api.update_administration_user(%L::uuid,%L::jsonb,%L)',
  :'administrator',(:'stale_command')::text,'web'),'P0001','FORBIDDEN',
  'administrator cannot mutate its own access');
reset role;

select updated_at as seller_b_updated_at from api.user_profiles where id=:'seller_b' \gset
select jsonb_build_object(
  'schemaVersion',1,'expectedUpdatedAt',:'seller_b_updated_at'::timestamptz,
  'status','inactive','roles',jsonb_build_array('seller'),'sellerScopeIds','[]'::jsonb,
  'reason','Bloqueio preventivo solicitado pelo gestor para valida\u00e7\u00e3o TESTE',
  'idempotencyKey','41000000-0000-4000-8000-000000000003'
) as block_command \gset
set local role authenticated;
select set_config('request.jwt.claim.sub',:'administrator',true);
select api.update_administration_user(:'seller_b'::uuid,(:'block_command')::jsonb,'web') as blocked_result \gset
select is((:'blocked_result')::jsonb->'user'->>'status','inactive','administrator can block another existing user');
select ok((:'blocked_result')::jsonb->'user'->'blockedAt' <> 'null'::jsonb,
  'blocking records an explicit timestamp');
select set_config('request.jwt.claim.sub',:'seller_b',true);
select is(api.get_my_identity(),null::jsonb,'blocked target immediately loses its identity context');
reset role;

select updated_at as blocked_seller_updated_at from api.user_profiles where id=:'seller_b' \gset
select jsonb_set(jsonb_set(jsonb_set((:'block_command')::jsonb,'{expectedUpdatedAt}',
  to_jsonb(:'blocked_seller_updated_at'::timestamptz)),'{status}','"active"'::jsonb),
  '{idempotencyKey}','"41000000-0000-4000-8000-000000000005"'::jsonb) as reactivate_command \gset
set local role authenticated;
select set_config('request.jwt.claim.sub',:'administrator',true);
select api.update_administration_user(:'seller_b'::uuid,(:'reactivate_command')::jsonb,'web') as reactivated_result \gset
select is((:'reactivated_result')::jsonb->'user'->>'status','active',
  'administrator can explicitly reactivate another existing user');
select is((:'reactivated_result')::jsonb->'user'->'blockedAt','null'::jsonb,
  'reactivation clears the blocking timestamp');
select set_config('request.jwt.claim.sub',:'seller_b',true);
select is(api.get_my_identity()->'roles','["seller"]'::jsonb,
  'reactivated target resolves its preserved identity again');
reset role;

select updated_at as seller_a_updated_at from api.user_profiles where id=:'seller_a' \gset
select jsonb_build_object(
  'schemaVersion',1,'expectedUpdatedAt',:'seller_a_updated_at'::timestamptz,
  'status','active','roles',jsonb_build_array('seller'),
  'sellerScopeIds',jsonb_build_array(:'seller_b'::uuid),
  'reason','Escopo inv\u00e1lido para perfil sem papel de gestor TESTE',
  'idempotencyKey','41000000-0000-4000-8000-000000000004'
) as invalid_scope_command \gset
set local role authenticated;
select set_config('request.jwt.claim.sub',:'administrator',true);
select throws_ok(format('select api.update_administration_user(%L::uuid,%L::jsonb,%L)',
  :'seller_a',(:'invalid_scope_command')::text,'web'),'P0001','VALIDATION_FAILED',
  'seller scopes are rejected when the manager role is absent');
reset role;

select ok(pg_catalog.pg_get_functiondef('api.update_administration_user(uuid,jsonb,text)'::regprocedure)
  like '%other_role.code = ''administrator''%other_profile.status = ''active''%',
  'mutation keeps an explicit last-active-administrator guard in addition to self-protection');
select ok(pg_catalog.pg_get_functiondef('api.update_administration_user(uuid,jsonb,text)'::regprocedure)
  like '%pg_advisory_xact_lock%identity.active-administrator-set%',
  'administrator-set changes are serialized before the last-active guard');

select * from finish();
rollback;
