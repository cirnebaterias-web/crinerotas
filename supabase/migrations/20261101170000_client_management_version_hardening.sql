-- Story 3.12 follow-up: keep expectedVersion within PostgreSQL integer range.
-- Forward-only security hardening: rolling back would restore an overflow path.
begin;

select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cirne:database:migrate'));
set local lock_timeout = '5s';

do $membership$
begin
  execute pg_catalog.format('grant cirne_route_executor to %I with set true granted by current_user', current_user);
end
$membership$;
grant create on schema private to cirne_route_executor;
set local role cirne_route_executor;

create or replace function private.client_update_command_valid(p_command jsonb)
returns boolean language sql immutable security invoker set search_path = ''
as $function$
  select private.client_create_command_valid(
    (p_command - array['expectedVersion','reason']) || jsonb_build_object(
      'externalReference', 'VALIDATION-PLACEHOLDER'))
    and (p_command - array['schemaVersion','expectedVersion','reason','name','address','latitude','longitude',
      'portfolioReference','sellerEmail','status']) = '{}'::jsonb
    and jsonb_typeof(p_command -> 'expectedVersion') = 'number'
    and case
      when coalesce(p_command ->> 'expectedVersion','') ~ '^[1-9][0-9]*$'
        then (p_command ->> 'expectedVersion')::numeric <= 2147483647
      else false
    end
    and jsonb_typeof(p_command -> 'reason') = 'string'
    and char_length(btrim(p_command ->> 'reason')) between 1 and 500;
$function$;

comment on function private.client_update_command_valid(jsonb) is
  'Validates managed client updates and bounds expectedVersion to PostgreSQL integer range.';

reset role;
revoke create on schema private from cirne_route_executor;
do $membership$
begin
  execute pg_catalog.format('revoke cirne_route_executor from %I granted by current_user', current_user);
end
$membership$;

commit;
