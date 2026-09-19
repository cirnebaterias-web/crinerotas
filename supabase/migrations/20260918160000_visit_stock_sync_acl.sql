begin;

do $preflight$
begin
  if to_regprocedure('private.sync_event(uuid,jsonb)') is null
     or not exists (select 1 from pg_catalog.pg_roles where rolname = 'cirne_sync_executor') then
    raise exception 'Visit stock sync ACL hardening requires the sync capability';
  end if;
end
$preflight$;

do $sync_ownership$
begin
  execute pg_catalog.format('grant cirne_sync_executor to %I with set true granted by current_user', current_user);
end
$sync_ownership$;
set local role cirne_sync_executor;
revoke all on function private.sync_event(uuid, jsonb) from public, anon, authenticated;
reset role;
do $sync_ownership$
begin
  execute pg_catalog.format('revoke cirne_sync_executor from %I granted by current_user', current_user);
end
$sync_ownership$;

commit;
