-- Restores the absolute 30 m check-in guard from Story 4.27.
begin;
select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cirne:database:migrate'));
set local lock_timeout = '5s';

do $membership$
begin
  execute pg_catalog.format(
    'grant cirne_visit_executor to %I with set true granted by current_user',
    current_user
  );
end
$membership$;

grant create on schema api to cirne_visit_executor;
set local role cirne_visit_executor;

create or replace function api.save_visit_checkin_evidence(
  p_device_id uuid,
  p_idempotency_key uuid,
  p_command jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  actor_id uuid := private.visit_attachment_identity();
  visit_row api.visits%rowtype;
  client_position extensions.geography(point, 4326);
  captured_position extensions.geography(point, 4326);
  latitude_value double precision;
  longitude_value double precision;
  client_latitude_value double precision;
  client_longitude_value double precision;
begin
  begin
    latitude_value := nullif(p_command #>> '{evidence,location,latitude}', '')::double precision;
    longitude_value := nullif(p_command #>> '{evidence,location,longitude}', '')::double precision;
  exception when others then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end;

  select visit.* into visit_row
  from api.visits visit
  where visit.seller_id = actor_id
    and visit.device_id = p_device_id
    and visit.offline_id = (p_command ->> 'offlineId')::uuid;

  if not found then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;

  begin
    client_latitude_value := nullif(visit_row.context_snapshot #>> '{client,latitude}', '')::double precision;
    client_longitude_value := nullif(visit_row.context_snapshot #>> '{client,longitude}', '')::double precision;
  exception when others then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end;

  if (client_latitude_value is null) <> (client_longitude_value is null) then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;

  if client_latitude_value is not null then
    client_position := extensions.st_setsrid(
      extensions.st_makepoint(client_longitude_value, client_latitude_value), 4326
    )::extensions.geography;
  end if;

  if latitude_value is null or longitude_value is null then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;

  captured_position := extensions.st_setsrid(
    extensions.st_makepoint(longitude_value, latitude_value), 4326
  )::extensions.geography;

  if client_position is not null
     and not extensions.st_dwithin(client_position, captured_position, 30) then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;

  return api.save_visit_checkin_evidence_without_geofence(
    p_device_id,
    p_idempotency_key,
    p_command
  );
end
$function$;

reset role;
revoke create on schema api from cirne_visit_executor;
do $membership$
begin
  execute pg_catalog.format(
    'revoke cirne_visit_executor from %I granted by current_user',
    current_user
  );
end
$membership$;
commit;
