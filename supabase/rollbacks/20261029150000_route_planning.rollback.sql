begin;

drop policy if exists roles_route_planner_read on api.roles;
drop policy if exists user_role_assignments_route_planner_read on api.user_role_assignments;

do $ownership$
begin
  execute pg_catalog.format('grant cirne_route_executor to %I with set true granted by current_user', current_user);
end
$ownership$;
grant create on schema api, private to cirne_route_executor;
set local role cirne_route_executor;

drop function if exists api.list_management_clients(text,integer,integer,uuid);
drop function if exists api.get_route_planning(date,uuid);
drop function if exists api.update_route_draft(uuid,jsonb,uuid,text);
drop function if exists private.list_management_clients(text,integer,integer,uuid);
drop function if exists private.get_route_planning(date,uuid);
drop function if exists private.update_route_draft(uuid,jsonb,uuid,text);

create or replace function private.list_client_management_sellers()
returns jsonb language plpgsql stable security definer set search_path = ''
as $function$
declare identity_document jsonb := private.client_management_identity();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', seller.id, 'displayName', seller.display_name, 'email', private.user_email(seller.id)
    ) order by seller.display_name, seller.id)
    from api.user_profiles seller
    where seller.status = 'active' and seller.blocked_at is null
      and (identity_document -> 'roles' ? 'administrator'
        or identity_document -> 'scopeIds' ? seller.id::text)
      and exists (
        select 1 from api.user_role_assignments assignment
        join api.roles role_row on role_row.id = assignment.role_id and role_row.code = 'seller'
        where assignment.user_id = seller.id and assignment.revoked_at is null
      )
  ), '[]'::jsonb);
end
$function$;

drop function private.change_route_composition(uuid,jsonb,uuid,text);
alter function private.change_route_composition_legacy_unscoped(uuid,jsonb,uuid,text)
  rename to change_route_composition;
drop function private.create_route_draft(jsonb);
alter function private.create_route_draft_legacy_unscoped(jsonb)
  rename to create_route_draft;
drop function if exists private.assert_route_stop_portfolio(uuid,jsonb);

reset role;
revoke create on schema api, private from cirne_route_executor;
do $ownership$
begin
  execute pg_catalog.format('revoke cirne_route_executor from %I granted by current_user', current_user);
end
$ownership$;

do $audit_ownership$
begin
  execute pg_catalog.format('grant cirne_sync_executor to %I with set true granted by current_user', current_user);
end
$audit_ownership$;
grant create on schema private to cirne_sync_executor;
set local role cirne_sync_executor;
drop index if exists private.audit_events_route_draft_update_idempotency_key;
reset role;
revoke create on schema private from cirne_sync_executor;
do $audit_ownership$
begin
  execute pg_catalog.format('revoke cirne_sync_executor from %I granted by current_user', current_user);
end
$audit_ownership$;

commit;
