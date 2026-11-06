-- Correct already-applied local instances without resetting imported data.
begin;
do $membership$
begin
  execute pg_catalog.format('grant cirne_administration_executor to %I with set true granted by current_user', current_user);
end
$membership$;
grant create on schema api to cirne_administration_executor;
set local role cirne_administration_executor;
do $repair$
declare definition text;
begin
  select pg_catalog.pg_get_functiondef('api.update_seller_route_profile(uuid,jsonb,text)'::regprocedure)
    into definition;
  if definition not like '%#variable_conflict use_variable%' then
    definition := replace(definition, E'AS $function$\n', E'AS $function$\n#variable_conflict use_variable\n');
    execute definition;
  end if;
end
$repair$;
reset role;
revoke create on schema api from cirne_administration_executor;
do $membership$
begin
  execute pg_catalog.format('revoke cirne_administration_executor from %I granted by current_user', current_user);
end
$membership$;
commit;
