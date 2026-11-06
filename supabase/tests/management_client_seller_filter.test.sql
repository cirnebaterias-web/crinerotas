begin;

select plan(2);

select id as manager_id from auth.users where raw_user_meta_data ->> 'actorKey'='manager_a' \gset
select id as seller_a_id from auth.users where raw_user_meta_data ->> 'actorKey'='seller_a' \gset
select id as seller_b_id from auth.users where raw_user_meta_data ->> 'actorKey'='seller_b' \gset

set local role service_role;
insert into api.clients(id,external_reference,name,address,status) values
  ('a1000000-0000-4000-8000-000000000001','90000000000001','Cliente do vendedor A','Rua A','active'),
  ('b1000000-0000-4000-8000-000000000001','90000000000002','Cliente do vendedor B','Rua B','active'),
  ('c1000000-0000-4000-8000-000000000001','90000000000003','Cliente sem vendedor','Rua C','active');
insert into api.client_seller_scopes(client_id,seller_id,assigned_by) values
  ('a1000000-0000-4000-8000-000000000001',:'seller_a_id',:'manager_id'),
  ('b1000000-0000-4000-8000-000000000001',:'seller_b_id',:'manager_id');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_id', true);
select is(
  api.list_management_clients('Cliente do vendedor',1,100,:'seller_a_id'::uuid) #>> '{pagination,totalCount}',
  '1',
  'administrator seller filter returns only the requested portfolio'
);
select is(
  api.list_management_clients('Cliente do vendedor',1,100,:'seller_a_id'::uuid) #>> '{clients,0,sellerId}',
  :'seller_a_id',
  'filtered rows retain the requested seller assignment'
);

select * from finish();
rollback;
