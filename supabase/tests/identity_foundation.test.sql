begin;

select plan(43);

select has_schema('api', 'api schema exists');
select has_schema('private', 'private schema exists');
select has_table('api', 'user_profiles', 'user_profiles exists');
select has_table('api', 'roles', 'roles exists');
select has_table('api', 'role_permissions', 'role_permissions exists');
select has_table('api', 'user_role_assignments', 'user_role_assignments exists');
select has_table('api', 'user_seller_scopes', 'user_seller_scopes exists');
select has_function('api', 'get_my_identity', array[]::text[], 'public identity wrapper exists');
select has_function('private', 'resolve_current_identity', array[]::text[], 'private identity resolver exists');

select ok(
  (select relrowsecurity and relforcerowsecurity
   from pg_catalog.pg_class
   where oid = 'api.user_profiles'::regclass),
  'RLS is enabled and forced on user_profiles'
);
select is(
  (select count(*)::integer
   from pg_catalog.pg_class
   where oid in (
     'api.roles'::regclass,
     'api.role_permissions'::regclass,
     'api.user_role_assignments'::regclass,
     'api.user_seller_scopes'::regclass
   ) and relrowsecurity and relforcerowsecurity),
  4,
  'RLS is enabled and forced on every remaining identity table'
);
select ok(
  not (select rolcanlogin or rolbypassrls or rolsuper
       from pg_catalog.pg_roles where rolname = 'cirne_identity_executor'),
  'identity executor cannot login or bypass RLS'
);
select is(
  (select pg_catalog.pg_get_userbyid(proowner)
   from pg_catalog.pg_proc
   where oid = 'private.resolve_current_identity()'::regprocedure),
  'cirne_identity_executor',
  'private resolver has the dedicated owner'
);
select is(
  (select pg_catalog.pg_get_userbyid(proowner)
   from pg_catalog.pg_proc
   where oid = 'api.get_my_identity()'::regprocedure),
  'cirne_identity_executor',
  'public wrapper has the dedicated owner'
);
select ok(
  (select prosecdef from pg_catalog.pg_proc
   where oid = 'api.get_my_identity()'::regprocedure),
  'public wrapper is security definer under the non-bypass executor'
);
select ok(
  (select pg_catalog.pg_get_functiondef('private.resolve_current_identity()'::regprocedure)
     like '%SET search_path TO %'),
  'private resolver pins an empty search_path'
);

select ok(not has_schema_privilege('anon', 'api', 'USAGE'), 'anon cannot use api schema');
select ok(not has_schema_privilege('anon', 'private', 'USAGE'), 'anon cannot use private schema');
select ok(not has_schema_privilege('authenticated', 'private', 'USAGE'), 'authenticated cannot use private schema');
select ok(not has_table_privilege('anon', 'api.user_profiles', 'SELECT'), 'anon cannot read profiles');
select ok(has_table_privilege('authenticated', 'api.user_profiles', 'SELECT'), 'authenticated can read its RLS-filtered profile');
select ok(not has_table_privilege('authenticated', 'api.roles', 'SELECT'), 'authenticated cannot read the role catalog directly');
select ok(has_function_privilege('authenticated', 'api.get_my_identity()', 'EXECUTE'), 'authenticated can execute the identity wrapper');
select ok(not has_function_privilege('authenticated', 'private.resolve_current_identity()', 'EXECUTE'), 'authenticated cannot execute the private resolver');
select ok(not has_function_privilege('anon', 'api.get_my_identity()', 'EXECUTE'), 'anon cannot execute the identity wrapper');

select is((select count(*)::integer from api.roles), 3, 'only confirmed roles are seeded');
select is((select count(*)::integer from api.role_permissions), 8, 'only minimal identity, sync and route capabilities are seeded');
select is((select count(*)::integer from api.user_profiles), 5, 'five synthetic profiles were provisioned');
select is((select count(*)::integer from api.user_role_assignments where revoked_at is null), 5, 'each synthetic actor has one active role');
select is((select count(*)::integer from api.user_seller_scopes where revoked_at is null), 1, 'only manager A to seller A scope exists');

select id as seller_a_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'seller_a' \gset
select id as seller_b_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'seller_b' \gset
select id as manager_a_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'manager_a' \gset
select id as blocked_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'blocked' \gset

set local role authenticated;
select set_config('request.jwt.claim.sub', :'seller_a_id', true);
select is(api.get_my_identity() ->> 'id', :'seller_a_id', 'seller A resolves only its own identity');
select is(api.get_my_identity() -> 'roles', '["seller"]'::jsonb, 'seller A receives its active role');
select is(api.get_my_identity() -> 'capabilities', '["identity.read_self", "route.read_self", "sync.write_self"]'::jsonb, 'seller A receives minimal capabilities');
select is(api.get_my_identity() -> 'scopeIds', jsonb_build_array(:'seller_a_id'::uuid), 'seller A scope is itself');
select is((select count(*)::integer from api.user_profiles), 1, 'direct profile read is restricted to the caller');
select is((select count(*)::integer from api.user_profiles where id = :'seller_b_id'::uuid), 0, 'seller A cannot read seller B profile');
select throws_ok('select * from api.roles', '42501', null, 'direct role catalog access is denied');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', 'not-a-uuid', true);
select is(api.get_my_identity(), null::jsonb, 'malformed subject fails closed without a cast error');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_a_id', true);
select is(api.get_my_identity() -> 'roles', '["manager"]'::jsonb, 'manager A receives its active role');
select is(api.get_my_identity() -> 'scopeIds', jsonb_build_array(:'seller_a_id'::uuid), 'manager A sees only delegated seller A');
select ok(not (api.get_my_identity() -> 'scopeIds' ? :'seller_b_id'), 'manager A does not see seller B');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', :'blocked_id', true);
select is(api.get_my_identity(), null::jsonb, 'blocked actor receives no identity context');
select is((select count(*)::integer from api.user_profiles), 0, 'blocked actor cannot read its profile directly');
reset role;

select * from finish();
rollback;
