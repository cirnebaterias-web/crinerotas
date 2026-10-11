-- Preserve scrap audit evidence without changing other modules' retention policy.
begin;
do $membership$ begin execute format('grant cirne_sync_executor to %I with set true granted by current_user',current_user); end $membership$;
grant create on schema private to cirne_sync_executor;
set local role cirne_sync_executor;
create function private.protect_scrap_audit_history() returns trigger language plpgsql set search_path='' as $$
begin if old.target_type='scrap' then raise exception using errcode='P0001',message='RETENTION_PROTECTED'; end if;
if tg_op='DELETE' then return old; end if; return new; end $$;
revoke all on function private.protect_scrap_audit_history() from public,anon,authenticated;
create trigger protect_scrap_audit_history before delete or update on private.audit_events for each row execute function private.protect_scrap_audit_history();
reset role;
revoke create on schema private from cirne_sync_executor;
do $membership$ begin execute format('revoke cirne_sync_executor from %I granted by current_user',current_user); end $membership$;
commit;
