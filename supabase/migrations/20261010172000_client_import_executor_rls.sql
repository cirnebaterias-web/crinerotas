-- The non-login executor remains subject to FORCE RLS; only its security-definer
-- import functions receive row access.
begin;
do $membership$
begin
  execute pg_catalog.format('grant cirne_route_executor to %I with set true granted by current_user', current_user);
end
$membership$;
set local role cirne_route_executor;
create policy import_batches_executor_all on api.import_batches
  for all to cirne_route_executor using (true) with check (true);
create policy import_batch_rows_executor_all on private.import_batch_rows
  for all to cirne_route_executor using (true) with check (true);
reset role;
create policy client_seller_scopes_import_executor_read on api.client_seller_scopes
  for select to cirne_route_executor using (true);
do $membership$
begin
  execute pg_catalog.format('revoke cirne_route_executor from %I granted by current_user', current_user);
end
$membership$;
commit;
