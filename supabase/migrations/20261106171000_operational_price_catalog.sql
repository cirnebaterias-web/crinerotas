-- Story 4.27: complete the already-published visit catalog without replacing
-- parameter-set IDs held by visits currently in progress.
begin;
select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cirne:database:migrate'));
set local lock_timeout = '5s';

do $ownership$ begin
  execute pg_catalog.format('grant cirne_visit_executor to %I with set true', current_user);
end $ownership$;
set local role cirne_visit_executor;

do $catalog$
declare
  set_id uuid;
begin
  select id into set_id from api.parameter_sets where status = 'published';
  if set_id is null then return; end if;

  alter table api.parameter_values disable trigger parameter_values_guard_published;
  insert into api.parameter_values (id, parameter_set_id, category, code, label, sort_order)
  values
    ('42700000-0000-4000-8000-000000000001',set_id,'competitor','heliar','Heliar',1),
    ('42700000-0000-4000-8000-000000000002',set_id,'competitor','america','América',2),
    ('42700000-0000-4000-8000-000000000003',set_id,'competitor','durex','Durex',3),
    ('42700000-0000-4000-8000-000000000004',set_id,'competitor','acdelco','ACDelco',4),
    ('42700000-0000-4000-8000-000000000005',set_id,'competitor','moura','Moura',10),
    ('42700000-0000-4000-8000-000000000006',set_id,'competitor','zetta','Zetta',11),
    ('42700000-0000-4000-8000-000000000007',set_id,'competitor','bosh','Bosh',12),
    ('42700000-0000-4000-8000-000000000008',set_id,'competitor','tudor','Tudor',13),
    ('42700000-0000-4000-8000-000000000009',set_id,'competitor','pioneiro','Pioneiro',14),
    ('42700000-0000-4000-8000-000000000010',set_id,'competitor_price_technology','sli','SLI',1),
    ('42700000-0000-4000-8000-000000000011',set_id,'competitor_price_technology','efb','EFB',2),
    ('42700000-0000-4000-8000-000000000012',set_id,'competitor_price_technology','agm','AGM',3),
    ('42700000-0000-4000-8000-000000000013',set_id,'competitor_price_condition','a_vista','À vista',1),
    ('42700000-0000-4000-8000-000000000014',set_id,'competitor_price_condition','a_prazo','A prazo',2),
    ('42700000-0000-4000-8000-000000000015',set_id,'competitor_price_unavailable_reason','cliente_nao_informou','Cliente não informou',1),
    ('42700000-0000-4000-8000-000000000016',set_id,'competitor_price_unavailable_reason','produto_indisponivel','Produto indisponível no PDV',2)
  on conflict (parameter_set_id, category, code) do nothing;
  alter table api.parameter_values enable trigger parameter_values_guard_published;
exception when others then
  alter table api.parameter_values enable trigger parameter_values_guard_published;
  raise;
end
$catalog$;

reset role;

commit;
