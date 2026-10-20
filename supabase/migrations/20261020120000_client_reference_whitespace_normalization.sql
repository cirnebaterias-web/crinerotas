-- Story 3.12 review follow-up: keep SQL normalization byte-for-byte equivalent
-- to the shared TypeScript rule for leading, trailing and internal whitespace.
begin;

select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cirne:database:migrate'));
set local lock_timeout = '5s';

do $membership$
begin
  execute pg_catalog.format('grant cirne_route_executor to %I with set true granted by current_user', current_user);
end
$membership$;
grant usage, create on schema private to cirne_route_executor;
set local role cirne_route_executor;

create or replace function private.normalize_client_external_reference(p_value text)
returns text language sql immutable security invoker set search_path = ''
as $function$
  select case
    when normalized.compact ~ '^[0-9.\-/ ]+$'
      then pg_catalog.regexp_replace(normalized.compact, '[^0-9]', '', 'g')
    else pg_catalog.upper(normalized.compact)
  end
  from (
    select pg_catalog.btrim(pg_catalog.regexp_replace(p_value, '\s+', ' ', 'g')) as compact
  ) normalized;
$function$;

do $collision_check$
declare
  conflicting_reference text;
begin
  select normalized_reference
    into conflicting_reference
  from (
    select private.normalize_client_external_reference(external_reference) as normalized_reference
    from api.clients
    where external_reference is not null
    group by private.normalize_client_external_reference(external_reference)
    having count(*) > 1
    limit 1
  ) collisions;

  if conflicting_reference is not null then
    raise exception using
      errcode = 'P0001',
      message = 'CLIENT_REFERENCE_NORMALIZATION_COLLISION',
      detail = jsonb_build_object('externalReference', conflicting_reference)::text;
  end if;
end
$collision_check$;

update api.clients
set external_reference = private.normalize_client_external_reference(external_reference)
where external_reference is not null
  and external_reference is distinct from private.normalize_client_external_reference(external_reference);

reset role;
revoke create on schema private from cirne_route_executor;
do $membership$
begin
  execute pg_catalog.format('revoke cirne_route_executor from %I granted by current_user', current_user);
end
$membership$;

commit;
