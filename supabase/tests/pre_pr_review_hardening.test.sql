begin;

select plan(8);

select id as manager_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'manager_a' \gset
select id as seller_id from auth.users where raw_user_meta_data ->> 'actorKey' = 'seller_a' \gset

select has_trigger(
  'api', 'commercial_actions', 'commercial_actions_set_authorship',
  'commercial actions derive authorship in the database'
);
select is(
  (select pg_catalog.pg_get_userbyid(proowner)
   from pg_catalog.pg_proc
   where oid = 'private.set_commercial_action_authorship()'::regprocedure),
  'cirne_identity_executor',
  'authorship trigger runs under the identity executor'
);
select is(
  (select pg_catalog.pg_get_userbyid(proowner)
   from pg_catalog.pg_proc
   where oid = 'private.can_access_visit_attachment(text)'::regprocedure),
  'cirne_visit_executor',
  'visit Storage predicate keeps the visit executor owner'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_id', true);
insert into api.commercial_actions (
  id, title, description, valid_from, valid_until, created_by, updated_by
) values (
  '39000000-0000-4000-8000-000000000099', 'Ação protegida', 'Autoria derivada do JWT',
  '2099-01-01', '2099-01-31', :'seller_id', :'seller_id'
);
reset role;

select is(
  (select created_by from api.commercial_actions where id = '39000000-0000-4000-8000-000000000099'),
  :'manager_id'::uuid,
  'insert ignores a spoofed creator'
);
select is(
  (select updated_by from api.commercial_actions where id = '39000000-0000-4000-8000-000000000099'),
  :'manager_id'::uuid,
  'insert ignores a spoofed updater'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_id', true);
update api.commercial_actions
set title = 'Ação protegida revisada', created_by = :'seller_id', updated_by = :'seller_id'
where id = '39000000-0000-4000-8000-000000000099';
reset role;

select is(
  (select created_by from api.commercial_actions where id = '39000000-0000-4000-8000-000000000099'),
  :'manager_id'::uuid,
  'update preserves the original creator'
);
select is(
  (select updated_by from api.commercial_actions where id = '39000000-0000-4000-8000-000000000099'),
  :'manager_id'::uuid,
  'update ignores a spoofed updater'
);

grant usage on schema private to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_id', true);
select is(
  private.can_access_visit_attachment('unreserved/path.jpg'),
  false,
  'Storage predicate returns false instead of raising for an actor without visit capability'
);
reset role;

select * from finish();
rollback;
