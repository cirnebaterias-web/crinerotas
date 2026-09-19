begin;

do $preflight$
begin
  if to_regprocedure('private.sync_event(uuid,jsonb)') is null
     or not exists (select 1 from pg_catalog.pg_roles where rolname = 'cirne_sync_executor')
     or not exists (select 1 from pg_catalog.pg_roles where rolname = 'cirne_visit_executor') then
    raise exception 'Visit stock sync caller ACL requires the visit and sync capabilities';
  end if;
end
$preflight$;

do $sync_ownership$
begin
  execute pg_catalog.format('grant cirne_sync_executor to %I with set true granted by current_user', current_user);
end
$sync_ownership$;
set local role cirne_sync_executor;
grant execute on function private.sync_event(uuid, jsonb) to cirne_visit_executor;
reset role;
do $sync_ownership$
begin
  execute pg_catalog.format('revoke cirne_sync_executor from %I granted by current_user', current_user);
end
$sync_ownership$;

commit;
