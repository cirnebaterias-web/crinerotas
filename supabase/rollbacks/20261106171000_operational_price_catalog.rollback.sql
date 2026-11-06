begin;
-- Values may already be referenced by field visits; rollback is intentionally guarded.
do $rollback$
begin
  if exists (select 1 from api.competitor_prices where competitor_id::text like '42700000-%'
    or technology_id::text like '42700000-%' or condition_id::text like '42700000-%')
    or exists (select 1 from api.competitor_price_reports where unavailable_reason_id::text like '42700000-%') then
    raise exception 'Operational price catalog is referenced and cannot be removed';
  end if;
  alter table api.parameter_values disable trigger parameter_values_guard_published;
  delete from api.parameter_values where id::text like '42700000-%';
  alter table api.parameter_values enable trigger parameter_values_guard_published;
exception when others then
  alter table api.parameter_values enable trigger parameter_values_guard_published;
  raise;
end
$rollback$;
commit;
