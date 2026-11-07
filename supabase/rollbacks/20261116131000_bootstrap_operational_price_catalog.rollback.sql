begin;
select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cirne:database:migrate'));

do $rollback$
begin
  if exists (
    select 1 from api.visits
    where parameter_set_id = '42700000-0000-4000-8000-000000000100'
  ) then
    raise exception 'Cannot remove operational catalog after visits reference it';
  end if;

  delete from api.parameter_values
  where parameter_set_id = '42700000-0000-4000-8000-000000000100';
  delete from api.parameter_sets
  where id = '42700000-0000-4000-8000-000000000100';
end
$rollback$;

commit;
