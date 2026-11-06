begin;

select plan(15);

select has_table('api', 'seller_route_profiles', 'seller route profiles exist');
select has_table('private', 'seller_route_profile_commands', 'idempotency commands exist');
select has_function('api', 'get_seller_route_profile', array['uuid'], 'profile read RPC exists');
select has_function('api', 'update_seller_route_profile', array['uuid','jsonb','text'], 'profile write RPC exists');
select ok((select relrowsecurity and relforcerowsecurity from pg_catalog.pg_class
  where oid = 'api.seller_route_profiles'::regclass), 'profile table forces RLS');
select ok(not has_table_privilege('authenticated','api.seller_route_profiles','SELECT'),
  'authenticated cannot read profiles directly');

select id as seller_a_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'seller_a' \gset
select id as seller_b_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'seller_b' \gset
select id as manager_a_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'manager_a' \gset

set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_a_id', true);

select is(api.get_seller_route_profile(:'seller_a_id'::uuid) ->> 'lifecycle', 'active',
  'missing profile projects as active without inventing a city');
select is(api.get_seller_route_profile(:'seller_a_id'::uuid) -> 'baseCity', 'null'::jsonb,
  'missing city remains explicitly null');

select is((api.update_seller_route_profile(:'seller_a_id'::uuid, jsonb_build_object(
  'schemaVersion',1,'expectedVersion',0,'offboardingAt','2099-12-01T03:00:00Z',
  'baseCity',jsonb_build_object('city','Natal','state','RN','ibgeCode','2408102',
    'latitude',-5.830125,'longitude',-35.212817,'reference','municipal_seat','source','IBGE'),
  'reason','Agendamento futuro validado pela gestao.','idempotencyKey','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
), 'cli') -> 'profile' ->> 'lifecycle'), 'offboarding_scheduled',
  'future offboarding remains scheduled');
select is(api.get_seller_route_profile(:'seller_a_id'::uuid) ->> 'portfolioState', 'assigned',
  'portfolio stays assigned before the effective instant');
select is((api.update_seller_route_profile(:'seller_a_id'::uuid, jsonb_build_object(
  'schemaVersion',1,'expectedVersion',0,'offboardingAt','2099-12-01T03:00:00Z',
  'baseCity',jsonb_build_object('city','Natal','state','RN','ibgeCode','2408102',
    'latitude',-5.830125,'longitude',-35.212817,'reference','municipal_seat','source','IBGE'),
  'reason','Agendamento futuro validado pela gestao.','idempotencyKey','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
), 'cli') ->> 'replayed'), 'true', 'same command replays safely');
select throws_ok(format($sql$select api.update_seller_route_profile(%L::uuid, jsonb_build_object(
  'schemaVersion',1,'expectedVersion',1,'offboardingAt',null,'baseCity',null,
  'reason','Tentativa divergente com a mesma chave.','idempotencyKey','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
), 'cli')$sql$, :'seller_a_id'), 'P0001', 'IDEMPOTENCY_KEY_REUSED', 'changed command cannot reuse a key');
select throws_ok(format($sql$select api.get_seller_route_profile(%L::uuid)$sql$, :'seller_b_id'),
  'P0001', 'FORBIDDEN', 'manager cannot read an out-of-scope seller');

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', :'seller_a_id', true);
select throws_ok(format($sql$select api.get_seller_route_profile(%L::uuid)$sql$, :'seller_a_id'),
  'P0001', 'FORBIDDEN', 'seller cannot manage its operational profile');
reset role;

select is((select count(*)::integer from private.audit_events where target_type='seller_route_profile'
  and target_id=:'seller_a_id'::uuid and action='seller.route-profile.updated.v1'), 1,
  'profile change has one durable audit event');

select * from finish();
rollback;
