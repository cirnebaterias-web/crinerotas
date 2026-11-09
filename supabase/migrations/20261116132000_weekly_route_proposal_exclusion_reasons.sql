begin;

do $membership$
begin
  execute format('grant cirne_route_executor to %I with set true granted by current_user', current_user);
end
$membership$;

grant create on schema private to cirne_route_executor;
set local role cirne_route_executor;

do $migration$
declare
  original_definition text;
  updated_definition text;
begin
  select pg_get_functiondef(
    'private.validate_weekly_route_proposal(uuid,date,jsonb)'::regprocedure
  ) into original_definition;

  updated_definition := replace(
    original_definition,
    $$not in ('inactive_lost','no_purchase_history','client_not_active','no_navigable_location')$$,
    $$not in ('inactive_lost','no_purchase_history','client_not_active','no_navigable_location','daily_distance_limit','daily_capacity_reached')$$
  );

  if updated_definition = original_definition then
    raise exception 'weekly route exclusion validation signature was not found';
  end if;

  execute updated_definition;
end
$migration$;

reset role;
revoke create on schema private from cirne_route_executor;
do $membership$
begin
  execute format('revoke cirne_route_executor from %I granted by current_user', current_user);
end
$membership$;
commit;

