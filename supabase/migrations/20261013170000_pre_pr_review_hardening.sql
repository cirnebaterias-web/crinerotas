-- Pre-PR hardening: server-derived commercial-action authorship and fail-closed Storage policy checks.
begin;
select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cirne:database:migrate'));
set local lock_timeout = '5s';

do $identity_ownership$
begin
  execute pg_catalog.format('grant cirne_identity_executor to %I with set true granted by current_user', current_user);
end
$identity_ownership$;
grant create on schema private to cirne_identity_executor;
set local role cirne_identity_executor;

create function private.set_commercial_action_authorship()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  identity_document jsonb := private.resolve_current_identity();
  actor_id uuid;
  request_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
  );
begin
  if identity_document is null and request_role = 'service_role' then
    if tg_op = 'UPDATE' then new.created_by := old.created_by; end if;
    return new;
  end if;

  if identity_document is null
     or not (identity_document -> 'roles' @> '["manager"]'::jsonb)
     or not (identity_document -> 'capabilities' @> '["route.plan_scoped"]'::jsonb) then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;

  actor_id := (identity_document ->> 'id')::uuid;
  if tg_op = 'INSERT' then
    new.created_by := actor_id;
  else
    new.created_by := old.created_by;
  end if;
  new.updated_by := actor_id;
  return new;
end
$function$;

reset role;
revoke create on schema private from cirne_identity_executor;
do $identity_ownership$
begin
  execute pg_catalog.format('revoke cirne_identity_executor from %I granted by current_user', current_user);
end
$identity_ownership$;

create trigger commercial_actions_set_authorship
before insert or update on api.commercial_actions
for each row execute function private.set_commercial_action_authorship();
revoke all on function private.set_commercial_action_authorship() from public, anon, authenticated;

do $visit_ownership$
begin
  execute pg_catalog.format('grant cirne_visit_executor to %I with set true granted by current_user', current_user);
end
$visit_ownership$;
grant create on schema private to cirne_visit_executor;
set local role cirne_visit_executor;

create or replace function private.can_access_visit_attachment(p_path text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  identity_document jsonb := private.resolve_current_identity();
  actor_id uuid;
begin
  if identity_document is null
     or not (identity_document -> 'capabilities' @> '["visit.start_self"]'::jsonb) then
    return false;
  end if;

  actor_id := (identity_document ->> 'id')::uuid;
  return exists (
    select 1
    from api.visit_attachments attachment
    where attachment.storage_path = p_path
      and attachment.seller_id = actor_id
      and attachment.expires_at > clock_timestamp()
  );
end
$function$;

revoke all on function private.can_access_visit_attachment(text) from public, anon;
grant execute on function private.can_access_visit_attachment(text) to authenticated;
reset role;
revoke create on schema private from cirne_visit_executor;
do $visit_ownership$
begin
  execute pg_catalog.format('revoke cirne_visit_executor from %I granted by current_user', current_user);
end
$visit_ownership$;

commit;
