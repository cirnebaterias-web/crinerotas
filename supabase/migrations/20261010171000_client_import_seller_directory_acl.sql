-- The seller directory resolver must cross the protected auth schema without
-- broadening auth.users visibility for the route executor.
begin;
do $membership$
begin
  execute pg_catalog.format('grant cirne_route_executor to %I with set true granted by current_user', current_user);
end
$membership$;
alter function private.valid_import_seller(text) owner to postgres;
revoke all on function private.valid_import_seller(text) from public, anon, authenticated;
grant execute on function private.valid_import_seller(text) to cirne_route_executor;
create function private.user_email(p_user_id uuid)
returns text language sql stable security definer set search_path = ''
as $function$ select email from auth.users where id = p_user_id; $function$;
alter function private.user_email(uuid) owner to postgres;
revoke all on function private.user_email(uuid) from public, anon, authenticated;
grant execute on function private.user_email(uuid) to cirne_route_executor;
create function private.apply_import_client_scope(
  p_client_id uuid, p_seller_id uuid, p_actor_id uuid, p_batch_id uuid
) returns void language plpgsql volatile security definer set search_path = ''
as $function$
begin
  update api.client_seller_scopes set revoked_at = now(), updated_at = now()
  where client_id = p_client_id and seller_id <> p_seller_id
    and revoked_at is null and managed_by_import_batch_id is not null;
  insert into api.client_seller_scopes
    (client_id, seller_id, assigned_by, managed_by_import_batch_id)
  values (p_client_id, p_seller_id, p_actor_id, p_batch_id)
  on conflict (client_id, seller_id) where revoked_at is null do nothing;
end
$function$;
alter function private.apply_import_client_scope(uuid,uuid,uuid,uuid) owner to postgres;
revoke all on function private.apply_import_client_scope(uuid,uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function private.apply_import_client_scope(uuid,uuid,uuid,uuid) to cirne_route_executor;
do $membership$
begin
  execute pg_catalog.format('revoke cirne_route_executor from %I granted by current_user', current_user);
end
$membership$;
commit;
