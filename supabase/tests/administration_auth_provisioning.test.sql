begin;
select plan(11);

select has_function('api','create_administration_user',array['uuid','jsonb','text'],
  'administrative user provisioning RPC exists');
select has_function('api','record_administration_password_reset',array['uuid','jsonb','text'],
  'password reset audit RPC exists');
select has_function('api','complete_administration_password_reset',array['uuid','uuid','text'],
  'password reset completion RPC exists');
select ok(has_function_privilege('authenticated','api.create_administration_user(uuid,jsonb,text)','EXECUTE'),
  'authenticated callers can reach provisioning authorization');
select ok(not has_function_privilege('anon','api.create_administration_user(uuid,jsonb,text)','EXECUTE'),
  'anonymous callers cannot provision');
select ok(not has_function_privilege('anon','api.record_administration_password_reset(uuid,jsonb,text)','EXECUTE'),
  'anonymous callers cannot record password resets');
select ok(pg_catalog.pg_get_functiondef('api.create_administration_user(uuid,jsonb,text)'::regprocedure)
  not ilike '%password%', 'database provisioning never receives password material');

select id as administrator from auth.users where raw_user_meta_data->>'actorKey'='administrator' \gset
select id as seller from auth.users where raw_user_meta_data->>'actorKey'='seller_a' \gset
select set_config('request.jwt.claim.sub',:'administrator',true);
select api.record_administration_password_reset(:'seller',jsonb_build_object(
  'schemaVersion',1,'reason','Redefinicao controlada para teste','idempotencyKey','43700000-0000-4000-8000-000000000001'),'web') as result \gset
select is((:'result')::jsonb->>'replayed','false','first password reset audit is canonical');
select is(api.record_administration_password_reset(:'seller',jsonb_build_object(
  'schemaVersion',1,'reason','Redefinicao controlada para teste','idempotencyKey','43700000-0000-4000-8000-000000000001'),'web')->>'replayed',
  'true','password reset audit is idempotent');
select is(api.complete_administration_password_reset(:'seller','43700000-0000-4000-8000-000000000001','web')->>'state',
  'completed','password reset completion closes the pending command');
select ok(exists(select 1 from private.audit_events where target_id=:'seller'
  and action='identity.password.reset.v1' and before_data is null
  and after_data='{"credentialState":"temporary_password_set"}'::jsonb),
  'audit records state without credential material');

select * from finish();
rollback;
