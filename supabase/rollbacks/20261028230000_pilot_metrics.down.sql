begin;

drop function if exists api.get_pilot_metrics(date, date, uuid, uuid, text, text);
drop function if exists private.get_pilot_metrics(date, date, uuid, uuid, text, text);
do $visit_index_ownership$
begin
  execute pg_catalog.format('grant cirne_visit_executor to %I with set true granted by current_user', current_user);
end
$visit_index_ownership$;
grant create on schema api to cirne_visit_executor;
set local role cirne_visit_executor;
drop index if exists api.visits_pilot_metrics_idx;
reset role;
revoke create on schema api from cirne_visit_executor;
do $visit_index_ownership$
begin
  execute pg_catalog.format('revoke cirne_visit_executor from %I granted by current_user', current_user);
end
$visit_index_ownership$;

commit;
