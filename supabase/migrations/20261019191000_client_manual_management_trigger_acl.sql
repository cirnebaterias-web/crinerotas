-- Story 3.12 follow-up: execute reference normalization under the restricted
-- route executor so inserts by fixture owners do not need direct helper access.
begin;
do $membership$
begin
  execute pg_catalog.format('grant cirne_route_executor to %I with set true granted by current_user', current_user);
end
$membership$;
set local role cirne_route_executor;
alter function private.normalize_client_external_reference_row() security definer;
reset role;
do $membership$
begin
  execute pg_catalog.format('revoke cirne_route_executor from %I granted by current_user', current_user);
end
$membership$;
commit;
