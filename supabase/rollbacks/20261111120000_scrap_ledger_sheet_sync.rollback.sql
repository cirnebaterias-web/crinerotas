begin;
select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cirne:database:migrate'));
drop function if exists api.get_scrap_ledger_analytics(text,text,integer),api.get_client_scrap_summary(uuid),api.get_scrap_ledger_sync_status(),api.publish_scrap_ledger_snapshot(text,text,jsonb,jsonb,text),api.begin_scrap_ledger_sync(text,text),api.stage_scrap_ledger_entries(uuid,jsonb),api.stage_scrap_ledger_balances(uuid,jsonb),api.publish_staged_scrap_ledger(uuid,text,integer,integer),api.fail_scrap_ledger_sync(uuid,text);
drop function if exists private.scrap_ledger_document_allowed(jsonb,text),private.scrap_client_allowed(uuid),private.scrap_ledger_identity(text);
drop table if exists private.scrap_ledger_head,private.scrap_ledger_balances,private.scrap_ledger_entries,private.scrap_ledger_runs;
delete from api.role_permissions where permission_code in('scrap_ledger.sync','scrap_ledger.read');
commit;
