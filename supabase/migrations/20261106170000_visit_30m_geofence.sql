begin;
select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cirne:database:migrate'));
set local lock_timeout = '5s';

do $ownership$ begin
  execute pg_catalog.format('grant cirne_visit_executor to %I with set true', current_user);
end $ownership$;
grant create on schema api, private to cirne_visit_executor;

create table api.client_observed_locations (
  client_id uuid primary key references api.clients(id) on delete restrict,
  source_visit_id uuid not null references api.visits(id) on delete restrict,
  checkin_position extensions.geography(point, 4326) not null,
  checkout_position extensions.geography(point, 4326) not null,
  observed_position extensions.geography(point, 4326) not null,
  observed_at timestamptz not null,
  updated_at timestamptz not null default clock_timestamp(),
  constraint client_observed_locations_proximity_check
    check (extensions.st_dwithin(checkin_position, checkout_position, 30))
);
alter table api.client_observed_locations enable row level security;
alter table api.client_observed_locations force row level security;
revoke all on table api.client_observed_locations from public, anon, authenticated;
alter table api.client_observed_locations owner to cirne_visit_executor;

set local role cirne_visit_executor;

alter function api.save_visit_checkin_evidence(uuid,uuid,jsonb)
  rename to save_visit_checkin_evidence_without_geofence;
alter function api.complete_visit(uuid,uuid,jsonb)
  rename to complete_visit_without_geofence;

create function api.save_visit_checkin_evidence(p_device_id uuid, p_idempotency_key uuid, p_command jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $function$
declare
  actor_id uuid := private.visit_attachment_identity();
  visit_row api.visits%rowtype;
  client_position extensions.geography(point, 4326);
  captured_position extensions.geography(point, 4326);
  latitude_value double precision;
  longitude_value double precision;
begin
  begin
    latitude_value := nullif(p_command #>> '{evidence,location,latitude}', '')::double precision;
    longitude_value := nullif(p_command #>> '{evidence,location,longitude}', '')::double precision;
  exception when others then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end;
  select visit.* into visit_row from api.visits visit
    where visit.seller_id = actor_id and visit.device_id = p_device_id
      and visit.offline_id = (p_command ->> 'offlineId')::uuid;
  if not found then raise exception using errcode = 'P0001', message = 'FORBIDDEN'; end if;
  select client.location into client_position from api.clients client where client.id = visit_row.client_id;
  if latitude_value is null or longitude_value is null then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  captured_position := extensions.st_setsrid(
    extensions.st_makepoint(longitude_value, latitude_value), 4326)::extensions.geography;
  if client_position is not null and not extensions.st_dwithin(client_position, captured_position, 30) then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  return api.save_visit_checkin_evidence_without_geofence(p_device_id, p_idempotency_key, p_command);
end
$function$;

create function api.complete_visit(p_device_id uuid, p_idempotency_key uuid, p_command jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $function$
declare
  actor_id uuid := private.visit_attachment_identity();
  visit_row api.visits%rowtype;
  checkin_event api.location_events%rowtype;
  checkout_position extensions.geography(point, 4326);
  latitude_value double precision;
  longitude_value double precision;
  result jsonb;
begin
  begin
    latitude_value := nullif(p_command #>> '{evidence,location,latitude}', '')::double precision;
    longitude_value := nullif(p_command #>> '{evidence,location,longitude}', '')::double precision;
  exception when others then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end;
  if latitude_value is null or longitude_value is null then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  select visit.* into visit_row from api.visits visit
    where visit.seller_id = actor_id and visit.device_id = p_device_id
      and visit.offline_id = (p_command ->> 'offlineId')::uuid for update;
  if not found then raise exception using errcode = 'P0001', message = 'FORBIDDEN'; end if;
  select event.* into checkin_event from api.location_events event
    where event.visit_id = visit_row.id and event.kind = 'start'
      and event.evidence_payload_hash is not null for update;
  if not found or checkin_event.position is null then
    raise exception using errcode = 'P0001', message = 'EVENT_OUT_OF_ORDER';
  end if;
  checkout_position := extensions.st_setsrid(
    extensions.st_makepoint(longitude_value, latitude_value), 4326)::extensions.geography;
  if not extensions.st_dwithin(checkin_event.position, checkout_position, 30) then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  result := api.complete_visit_without_geofence(p_device_id, p_idempotency_key, p_command);
  if (select client.location is null from api.clients client where client.id = visit_row.client_id) then
    insert into api.client_observed_locations (
      client_id, source_visit_id, checkin_position, checkout_position, observed_position, observed_at)
    values (visit_row.client_id, visit_row.id, checkin_event.position, checkout_position,
      checkin_event.position, greatest(checkin_event.device_captured_at,
        (p_command #>> '{evidence,capturedAt}')::timestamptz))
    on conflict (client_id) do update set
      source_visit_id = excluded.source_visit_id,
      checkin_position = excluded.checkin_position,
      checkout_position = excluded.checkout_position,
      observed_position = excluded.observed_position,
      observed_at = excluded.observed_at,
      updated_at = clock_timestamp();
  end if;
  return result;
end
$function$;

alter function api.save_visit_checkin_evidence_without_geofence(uuid,uuid,jsonb) owner to cirne_visit_executor;
alter function api.complete_visit_without_geofence(uuid,uuid,jsonb) owner to cirne_visit_executor;
alter function api.save_visit_checkin_evidence(uuid,uuid,jsonb) owner to cirne_visit_executor;
alter function api.complete_visit(uuid,uuid,jsonb) owner to cirne_visit_executor;
revoke all on function api.save_visit_checkin_evidence_without_geofence(uuid,uuid,jsonb),
  api.complete_visit_without_geofence(uuid,uuid,jsonb) from public, anon, authenticated;
revoke all on function api.save_visit_checkin_evidence(uuid,uuid,jsonb),
  api.complete_visit(uuid,uuid,jsonb) from public, anon;
grant execute on function api.save_visit_checkin_evidence(uuid,uuid,jsonb),
  api.complete_visit(uuid,uuid,jsonb) to authenticated;

reset role;
revoke create on schema api, private from cirne_visit_executor;

commit;
