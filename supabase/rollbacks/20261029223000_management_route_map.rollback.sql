begin;

do $ownership$
begin
  execute pg_catalog.format('grant cirne_management_executor to %I with set true granted by current_user', current_user);
end
$ownership$;
grant create on schema api to cirne_management_executor;
set local role cirne_management_executor;

drop function if exists api.get_management_route_map(date);

reset role;
revoke create on schema api from cirne_management_executor;
do $ownership$
begin
  execute pg_catalog.format('revoke cirne_management_executor from %I granted by current_user', current_user);
end
$ownership$;

commit;
