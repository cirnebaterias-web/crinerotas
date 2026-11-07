-- Story 4.27: bootstrap the approved operational catalog when the environment
-- has no parameter set yet. Existing published catalogs remain untouched.
begin;
select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cirne:database:migrate'));
set local lock_timeout = '5s';

do $catalog$
declare
  set_id constant uuid := '42700000-0000-4000-8000-000000000100';
  publisher_id uuid;
  next_version integer;
begin
  if exists (select 1 from api.parameter_sets where status = 'published') then
    return;
  end if;

  select profile.id into publisher_id
  from api.user_profiles profile
  join api.user_role_assignments assignment
    on assignment.user_id = profile.id and assignment.revoked_at is null
  join api.roles role_row
    on role_row.id = assignment.role_id and role_row.code in ('administrator', 'manager')
  where profile.status = 'active' and profile.blocked_at is null
  order by case role_row.code when 'administrator' then 0 else 1 end,
    profile.created_at, profile.id
  limit 1;

  if publisher_id is null then
    -- Clean and synthetic environments provision identities only after the
    -- schema is available. Their identity provisioner creates and publishes
    -- the synthetic catalog; production still publishes here as soon as an
    -- authorized operator exists.
    return;
  end if;

  select coalesce(max(version), 0) + 1 into next_version from api.parameter_sets;
  insert into api.parameter_sets (id, version, status, valid_from)
  values (set_id, next_version, 'draft', '2026-09-30T00:00:00-03:00');

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
    ('42700000-0000-4000-8000-000000000016',set_id,'competitor_price_unavailable_reason','produto_indisponivel','Produto indisponível no PDV',2);

  update api.parameter_sets
  set status = 'published', published_at = statement_timestamp(), published_by = publisher_id
  where id = set_id and status = 'draft';
end
$catalog$;

commit;
