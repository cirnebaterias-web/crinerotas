-- Story 4.23: stable collection-route aggregate, versions and manager-controlled dispatch.
begin;
select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cirne:database:migrate'));
set local lock_timeout = '5s';

alter table api.logistics_pickups drop constraint logistics_pickups_operator_id_route_date_route_order_key;
alter table api.logistics_pickups add column route_archived_at timestamptz;
alter table api.logistics_pickups add column route_archive_reason text
  check(route_archive_reason is null or length(route_archive_reason) between 1 and 500);
create unique index logistics_pickups_active_route_order_key
  on api.logistics_pickups(operator_id,route_date,route_order) where route_archived_at is null;

create table api.scrap_collection_routes (
  id uuid primary key default gen_random_uuid(),
  route_date date not null,
  status text not null default 'draft' check(status in ('draft','approved','assigned','in_progress','completed','cancelled')),
  version integer not null default 1 check(version > 0),
  operator_id uuid references api.user_profiles(id) on delete restrict,
  generated_at timestamptz not null default now(),
  approved_by uuid references api.user_profiles(id) on delete restrict,
  approved_at timestamptz,
  completed_at timestamptz,
  created_by uuid not null references api.user_profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check((approved_by is null and approved_at is null) or (approved_by is not null and approved_at is not null)),
  check((status = 'completed') = (completed_at is not null))
);
create index scrap_collection_routes_date on api.scrap_collection_routes(route_date, created_at, id);
create index scrap_collection_routes_operator on api.scrap_collection_routes(operator_id, route_date);

create table api.scrap_collection_route_stops (
  id uuid primary key default gen_random_uuid(),
  route_id uuid not null references api.scrap_collection_routes(id) on delete restrict,
  schedule_id uuid not null unique references api.pickup_schedules(id) on delete restrict,
  client_name_snapshot text not null,
  document_snapshot text check(document_snapshot ~ '^(\d{11}|\d{14})$'),
  address_snapshot text not null,
  promised_weight_kg numeric not null check(promised_weight_kg > 0 and promised_weight_kg < 'Infinity'::numeric),
  location_snapshot extensions.geography(point, 4326),
  suggested_order integer not null check(suggested_order between 1 and 500),
  planned_order integer not null check(planned_order between 1 and 500),
  approximate_from_previous_km numeric check(approximate_from_previous_km >= 0),
  active boolean not null default true,
  removed_by uuid references api.user_profiles(id) on delete restrict,
  removed_at timestamptz,
  removal_reason text check(removal_reason is null or length(removal_reason) between 1 and 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check((active and removed_by is null and removed_at is null and removal_reason is null)
    or (not active and removed_by is not null and removed_at is not null and removal_reason is not null))
);
create index scrap_collection_route_stops_route on api.scrap_collection_route_stops(route_id, planned_order);
create unique index scrap_collection_route_stops_active_suggested_order_key
  on api.scrap_collection_route_stops(route_id,suggested_order) where active;
create unique index scrap_collection_route_stops_active_planned_order_key
  on api.scrap_collection_route_stops(route_id,planned_order) where active;

create table api.scrap_collection_route_events (
  id uuid primary key default gen_random_uuid(),
  route_id uuid not null references api.scrap_collection_routes(id) on delete restrict,
  version integer not null check(version > 0),
  actor_id uuid not null references api.user_profiles(id) on delete restrict,
  actor_name_snapshot text not null,
  action text not null check(action in ('created','revised','reordered','approved','assigned','reassigned','started','completed')),
  reason text,
  before_data jsonb,
  after_data jsonb not null,
  created_at timestamptz not null default now()
);
create index scrap_collection_route_events_route on api.scrap_collection_route_events(route_id, created_at, id);

create table private.scrap_collection_route_commands (
  actor_id uuid not null references api.user_profiles(id) on delete restrict,
  idempotency_key uuid not null,
  operation text not null,
  route_id uuid references api.scrap_collection_routes(id) on delete restrict,
  command jsonb not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key(actor_id, idempotency_key)
);

comment on table api.scrap_collection_routes is 'Stable route identity; composition/order changes increment version without replacing the route.';
comment on table api.scrap_collection_route_stops is 'Versioned dispatched promise snapshots; removed stops remain immutable history and actual outcomes remain owned by api.logistics_pickups.';
comment on table api.scrap_collection_route_events is 'Append-only managerial audit history for collection routes.';

do $tables$ declare t text; begin
  foreach t in array array['api.scrap_collection_routes','api.scrap_collection_route_stops','api.scrap_collection_route_events'] loop
    execute format('alter table %s enable row level security', t);
    execute format('alter table %s force row level security', t);
    execute format('revoke all on %s from public, anon, authenticated', t);
    execute format('grant select, insert, update on %s to cirne_scrap_executor', t);
    execute format('create policy scrap_route_executor on %s for all to cirne_scrap_executor using(true) with check(true)', t);
  end loop;
end $tables$;
revoke update on api.scrap_collection_route_events from cirne_scrap_executor;
alter table private.scrap_collection_route_commands enable row level security;
alter table private.scrap_collection_route_commands force row level security;
revoke all on private.scrap_collection_route_commands from public, anon, authenticated;
grant select, insert on private.scrap_collection_route_commands to cirne_scrap_executor;
create policy scrap_route_command_executor on private.scrap_collection_route_commands for all to cirne_scrap_executor
  using(true) with check(true);

do $roles$ begin
  execute format('grant cirne_scrap_executor to %I with set true granted by current_user', current_user);
end $roles$;
grant usage, create on schema api, private to cirne_scrap_executor;
do $roles$ begin
  execute format('grant cirne_visit_executor to %I with set true granted by current_user',current_user);
end $roles$;
set local role cirne_visit_executor;
grant select on api.visits, api.location_events to cirne_scrap_executor;
reset role;
do $roles$ begin
  execute format('revoke cirne_visit_executor from %I granted by current_user',current_user);
end $roles$;
set local role cirne_scrap_executor;

create function private.scrap_collection_route_manager(p_identity jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(p_identity ->> 'status' = 'active'
    and p_identity -> 'capabilities' ? 'scrap.dispatch_pickups'
    and (p_identity -> 'roles' ? 'administrator'
      or (p_identity -> 'roles' ? 'manager' and jsonb_array_length(p_identity -> 'scopeIds') > 0)), false);
$$;

create function private.scrap_collection_route_visible(p_identity jsonb, p_route_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select (private.scrap_collection_route_manager(p_identity) and not exists(
    select 1 from api.scrap_collection_route_stops stop
    join api.pickup_schedules schedule on schedule.id=stop.schedule_id
    where stop.route_id=p_route_id and not private.logistics_manager(p_identity,schedule.seller_id)))
    or coalesce(p_identity ->> 'status'='active' and p_identity -> 'roles' ? 'logistics'
      and p_identity -> 'capabilities' ? 'scrap.execute_pickups'
      and exists(select 1 from api.scrap_collection_routes route
        where route.id=p_route_id and route.operator_id=(p_identity ->> 'id')::uuid),false);
$$;

create function private.scrap_collection_route_projection(p_route_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare route_row api.scrap_collection_routes%rowtype; stops_value jsonb; total_count integer;
  geocoded_count integer; completed_count integer; derived_status text;
begin
  select * into route_row from api.scrap_collection_routes where id = p_route_id;
  if route_row.id is null then raise exception using errcode = 'P0001', message = 'NOT_FOUND'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'scheduleId', stop.schedule_id, 'clientName', stop.client_name_snapshot,
      'address', stop.address_snapshot, 'promisedWeightKg', stop.promised_weight_kg::text,
      'location', case when stop.location_snapshot is null then null else jsonb_build_object(
        'latitude', extensions.st_y(stop.location_snapshot::extensions.geometry),
        'longitude', extensions.st_x(stop.location_snapshot::extensions.geometry)) end,
      'suggestedOrder', stop.planned_order,
      'approximateFromPreviousKm', stop.approximate_from_previous_km::double precision,
      'geographyStatus', case when stop.location_snapshot is null then 'pending_location' else 'calculated' end,
      'result', pickup.result_outcome) order by stop.planned_order), '[]'::jsonb),
    count(*)::integer, count(stop.location_snapshot)::integer,
    count(*) filter(where pickup.result_outcome is not null)::integer
    into stops_value, total_count, geocoded_count, completed_count
    from api.scrap_collection_route_stops stop
    left join api.logistics_pickups pickup on pickup.schedule_id = stop.schedule_id
    where stop.route_id = route_row.id and stop.active;
  derived_status := case when route_row.status = 'cancelled' then 'cancelled'
    when total_count > 0 and completed_count = total_count then 'completed'
    when completed_count > 0 then 'in_progress' else route_row.status end;
  return jsonb_build_object('schemaVersion', 1, 'routeId', route_row.id, 'version', route_row.version,
    'routeDate', route_row.route_date, 'status', derived_status, 'operatorId', route_row.operator_id,
    'generatedAt', route_row.generated_at,
    'policy', jsonb_build_object('version','scrap-route-proximity-v1','method','centroid-edge-nearest-neighbor',
      'distance','haversine_approximation'),
    'stops', stops_value, 'counts', jsonb_build_object('total', total_count, 'geocoded', geocoded_count,
      'pendingLocation', total_count - geocoded_count, 'completed', completed_count));
end $$;

create function private.scrap_collection_route_recompute(p_route_id uuid)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare current_stop uuid; previous_location extensions.geography(point,4326); next_order integer := 1;
  processed uuid[] := '{}'::uuid[];
  centroid extensions.geometry; next_stop record;
begin
  select extensions.st_centroid(extensions.st_collect(location_snapshot::extensions.geometry)) into centroid
    from api.scrap_collection_route_stops where route_id = p_route_id and active and location_snapshot is not null;
  if centroid is not null then
    select id, location_snapshot into next_stop from api.scrap_collection_route_stops
      where route_id = p_route_id and active and location_snapshot is not null
      order by extensions.st_distance(location_snapshot, centroid::extensions.geography) desc, schedule_id limit 1;
    current_stop := next_stop.id; previous_location := next_stop.location_snapshot;
    while current_stop is not null loop
      update api.scrap_collection_route_stops set suggested_order = next_order, planned_order = next_order,
        approximate_from_previous_km = case when next_order = 1 then null else approximate_from_previous_km end,
        updated_at = now() where id = current_stop;
      processed := array_append(processed,current_stop);
      next_order := next_order + 1;
      select id, location_snapshot,
        round((extensions.st_distance(location_snapshot, previous_location) / 1000.0)::numeric, 1) distance_km
        into next_stop from api.scrap_collection_route_stops
        where route_id = p_route_id and active and location_snapshot is not null and not (id = any(processed))
        order by extensions.st_distance(location_snapshot, previous_location), schedule_id limit 1;
      if not found then current_stop := null; else
        current_stop := next_stop.id;
        update api.scrap_collection_route_stops set approximate_from_previous_km = next_stop.distance_km where id = current_stop;
        previous_location := next_stop.location_snapshot;
      end if;
    end loop;
  end if;
  for next_stop in select id from api.scrap_collection_route_stops
    where route_id = p_route_id and active and not (id = any(processed)) order by client_name_snapshot, schedule_id loop
    update api.scrap_collection_route_stops set suggested_order = next_order, planned_order = next_order,
      approximate_from_previous_km = null, updated_at = now() where id = next_stop.id;
    next_order := next_order + 1;
  end loop;
end $$;

create function api.get_scrap_collection_route(p_route_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare identity_value jsonb := private.resolve_current_identity();
begin
  if identity_value is null then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;
  if not private.scrap_collection_route_visible(identity_value,p_route_id) then
    raise exception using errcode = 'P0001', message = 'NOT_FOUND';
  end if;
  return private.scrap_collection_route_projection(p_route_id);
end $$;

create function api.list_scrap_collection_routes(p_date date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare identity_value jsonb := private.resolve_current_identity(); routes_value jsonb;
begin
  if identity_value is null or not (private.scrap_collection_route_manager(identity_value)
    or (identity_value ->> 'status'='active' and identity_value -> 'roles' ? 'logistics'
      and identity_value -> 'capabilities' ? 'scrap.execute_pickups')) then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;
  select coalesce(jsonb_agg(private.scrap_collection_route_projection(route.id) order by route.created_at, route.id), '[]'::jsonb)
    into routes_value from api.scrap_collection_routes route where route.route_date = p_date
      and private.scrap_collection_route_visible(identity_value,route.id);
  return jsonb_build_object('schemaVersion',1,'date',p_date,'generatedAt',now(),'routes',routes_value);
end $$;

create function api.create_scrap_collection_route(p_idempotency_key uuid, p_command jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare identity_value jsonb := private.scrap_identity('scrap.dispatch_pickups'); actor uuid := (identity_value ->> 'id')::uuid;
  route_value api.scrap_collection_routes%rowtype; prior private.scrap_collection_route_commands%rowtype;
  response_value jsonb; schedule_count integer; stamp timestamptz := now();
begin
  if not private.scrap_collection_route_manager(identity_value) then raise exception using errcode='P0001',message='FORBIDDEN'; end if;
  select * into prior from private.scrap_collection_route_commands where actor_id=actor and idempotency_key=p_idempotency_key;
  if prior.actor_id is not null then
    if prior.operation <> 'create' or prior.command <> p_command then raise exception using errcode='P0001',message='IDEMPOTENCY_KEY_REUSED'; end if;
    return prior.response;
  end if;
  if coalesce(jsonb_typeof(p_command),'') <> 'object' or p_command - array['schemaVersion','routeDate','scheduleIds'] <> '{}'::jsonb
    or p_command ->> 'schemaVersion' <> '1' or coalesce(jsonb_typeof(p_command -> 'scheduleIds'),'') <> 'array'
    or jsonb_array_length(p_command -> 'scheduleIds') not between 1 and 500
    or coalesce(p_command ->> 'routeDate','') !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception using errcode='P0001',message='VALIDATION_FAILED';
  end if;
  if (select count(*) <> count(distinct value) from jsonb_array_elements_text(p_command -> 'scheduleIds')) then
    raise exception using errcode='P0001',message='VALIDATION_FAILED';
  end if;
  if exists(select 1 from jsonb_array_elements_text(p_command -> 'scheduleIds') value
    where value !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') then
    raise exception using errcode='P0001',message='VALIDATION_FAILED';
  end if;
  select count(*) into schedule_count from api.pickup_schedules schedule
    where schedule.id in (select value::uuid from jsonb_array_elements_text(p_command -> 'scheduleIds'))
      and schedule.status='pending' and private.logistics_manager(identity_value, schedule.seller_id)
      and not exists(select 1 from api.scrap_collection_route_stops used where used.schedule_id=schedule.id and used.active);
  if schedule_count <> jsonb_array_length(p_command -> 'scheduleIds') then
    raise exception using errcode='P0001',message='VALIDATION_FAILED';
  end if;
  insert into api.scrap_collection_routes(route_date,created_by,generated_at)
    values((p_command ->> 'routeDate')::date,actor,stamp) returning * into route_value;
  insert into api.scrap_collection_route_stops(route_id,schedule_id,client_name_snapshot,document_snapshot,
    address_snapshot,promised_weight_kg,location_snapshot,suggested_order,planned_order)
  select route_value.id,schedule.id,schedule.client_name_snapshot,
    case when regexp_replace(client.external_reference,'[^0-9]','','g') ~ '^(\d{11}|\d{14})$'
      and client.external_reference ~ '^[0-9./[:space:]-]+$'
      then regexp_replace(client.external_reference,'[^0-9]','','g') end,
    schedule.address_snapshot,schedule.estimated_weight_kg,observed.position,row_number() over(order by schedule.id),
    row_number() over(order by schedule.id)
    from api.pickup_schedules schedule join api.clients client on client.id=schedule.client_id
    left join lateral(select event.position from api.visits visit join api.location_events event on event.visit_id=visit.id
      where visit.client_id=client.id and event.position is not null
        and event.accuracy_m is not null and event.accuracy_m<=100
      order by event.device_captured_at desc,event.id desc limit 1) observed on true
    where schedule.id in (select value::uuid from jsonb_array_elements_text(p_command -> 'scheduleIds'));
  perform private.scrap_collection_route_recompute(route_value.id);
  response_value := private.scrap_collection_route_projection(route_value.id);
  insert into api.scrap_collection_route_events(route_id,version,actor_id,actor_name_snapshot,action,after_data)
    values(route_value.id,1,actor,identity_value ->> 'displayName','created',response_value);
  insert into private.scrap_collection_route_commands(actor_id,idempotency_key,operation,route_id,command,response)
    values(actor,p_idempotency_key,'create',route_value.id,p_command,response_value);
  return response_value;
end $$;

create function api.change_scrap_collection_route(p_route_id uuid, p_operation text, p_idempotency_key uuid, p_command jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare identity_value jsonb := private.scrap_identity('scrap.dispatch_pickups'); actor uuid := (identity_value ->> 'id')::uuid;
  route_value api.scrap_collection_routes%rowtype; prior private.scrap_collection_route_commands%rowtype;
  before_value jsonb; response_value jsonb; item jsonb; operator_value api.user_profiles%rowtype;
  old_operator uuid; action_value text; stamp timestamptz := now(); stop_value record;
  schedule_value api.pickup_schedules%rowtype; pickup_value api.logistics_pickups%rowtype;
  pickup_before jsonb; pickup_after jsonb; schedule_count integer;
begin
  if not private.scrap_collection_route_manager(identity_value) then raise exception using errcode='P0001',message='FORBIDDEN'; end if;
  if p_operation not in ('revise','reorder','approve','assign') then raise exception using errcode='P0001',message='VALIDATION_FAILED'; end if;
  select * into prior from private.scrap_collection_route_commands where actor_id=actor and idempotency_key=p_idempotency_key;
  if prior.actor_id is not null then
    if prior.operation <> p_operation or prior.route_id <> p_route_id or prior.command <> p_command then
      raise exception using errcode='P0001',message='IDEMPOTENCY_KEY_REUSED'; end if;
    return prior.response;
  end if;
  select * into route_value from api.scrap_collection_routes where id=p_route_id for update;
  if route_value.id is null then raise exception using errcode='P0001',message='NOT_FOUND'; end if;
  if not private.scrap_collection_route_visible(identity_value,route_value.id) then
    raise exception using errcode='P0001',message='NOT_FOUND';
  end if;
  if coalesce(jsonb_typeof(p_command),'') <> 'object'
    or p_command - (case when p_operation='revise' then array['schemaVersion','expectedVersion','scheduleIds','reason']
      when p_operation='reorder' then array['schemaVersion','expectedVersion','stops','reason']
      when p_operation='approve' then array['schemaVersion','expectedVersion','reason']
      else array['schemaVersion','expectedVersion','operatorId','reason'] end) <> '{}'::jsonb
    or coalesce(p_command ->> 'schemaVersion','') <> '1' or coalesce(p_command ->> 'expectedVersion','') !~ '^[1-9]\d*$'
    or (p_command ->> 'expectedVersion')::integer <> route_value.version
    or char_length(btrim(coalesce(p_command ->> 'reason',''))) not between 1 and 500 then
    raise exception using errcode='P0001',message=case when coalesce(p_command ->> 'expectedVersion','0') ~ '^[1-9]\d*$'
      and (p_command ->> 'expectedVersion')::integer <> route_value.version then 'VERSION_CONFLICT' else 'VALIDATION_FAILED' end;
  end if;
  if route_value.status in ('in_progress','completed','cancelled') then raise exception using errcode='P0001',message='VERSION_CONFLICT'; end if;
  before_value := private.scrap_collection_route_projection(route_value.id);
  if p_operation='revise' then
    if coalesce(jsonb_typeof(p_command -> 'scheduleIds'),'') <> 'array'
      or jsonb_array_length(p_command -> 'scheduleIds') not between 1 and 500
      or (select count(*) <> count(distinct value) from jsonb_array_elements_text(p_command -> 'scheduleIds'))
      or exists(select 1 from jsonb_array_elements_text(p_command -> 'scheduleIds') value
        where value !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') then
      raise exception using errcode='P0001',message='VALIDATION_FAILED';
    end if;
    if exists(select 1 from api.scrap_collection_route_stops stop
      join api.logistics_pickups pickup on pickup.schedule_id=stop.schedule_id
      where stop.route_id=route_value.id and stop.active and pickup.result_outcome is not null
        and stop.schedule_id not in(select value::uuid from jsonb_array_elements_text(p_command -> 'scheduleIds'))) then
      raise exception using errcode='P0001',message='VERSION_CONFLICT';
    end if;
    select count(*) into schedule_count from api.pickup_schedules schedule
      where schedule.id in(select value::uuid from jsonb_array_elements_text(p_command -> 'scheduleIds'))
        and schedule.status='pending' and private.logistics_manager(identity_value,schedule.seller_id)
        and not exists(select 1 from api.scrap_collection_route_stops used
          where used.schedule_id=schedule.id and used.active and used.route_id<>route_value.id);
    if schedule_count <> jsonb_array_length(p_command -> 'scheduleIds') then
      raise exception using errcode='P0001',message='VALIDATION_FAILED';
    end if;

    update api.logistics_pickups pickup set route_archived_at=stamp,
      route_archive_reason=p_command ->> 'reason',updated_at=stamp
      from api.scrap_collection_route_stops stop
      where stop.route_id=route_value.id and stop.active and pickup.schedule_id=stop.schedule_id
        and pickup.result_outcome is null;
    update api.scrap_collection_route_stops set active=false,removed_by=actor,removed_at=stamp,
      removal_reason=p_command ->> 'reason',updated_at=stamp
      where route_id=route_value.id and active;

    insert into api.scrap_collection_route_stops(route_id,schedule_id,client_name_snapshot,document_snapshot,
      address_snapshot,promised_weight_kg,location_snapshot,suggested_order,planned_order)
    select route_value.id,schedule.id,schedule.client_name_snapshot,
      case when regexp_replace(client.external_reference,'[^0-9]','','g') ~ '^(\d{11}|\d{14})$'
        and client.external_reference ~ '^[0-9./[:space:]-]+$'
        then regexp_replace(client.external_reference,'[^0-9]','','g') end,
      schedule.address_snapshot,schedule.estimated_weight_kg,observed.position,requested.ordinality,requested.ordinality
      from jsonb_array_elements_text(p_command -> 'scheduleIds') with ordinality requested(schedule_id,ordinality)
      join api.pickup_schedules schedule on schedule.id=requested.schedule_id::uuid
      join api.clients client on client.id=schedule.client_id
      left join api.scrap_collection_route_stops existing on existing.route_id=route_value.id and existing.schedule_id=schedule.id
      left join lateral(select event.position from api.visits visit join api.location_events event on event.visit_id=visit.id
        where visit.client_id=client.id and event.position is not null
          and event.accuracy_m is not null and event.accuracy_m<=100
        order by event.device_captured_at desc,event.id desc limit 1) observed on true
      where existing.id is null;
    update api.scrap_collection_route_stops stop set active=true,removed_by=null,removed_at=null,removal_reason=null,
      suggested_order=requested.ordinality,planned_order=requested.ordinality,updated_at=stamp
      from jsonb_array_elements_text(p_command -> 'scheduleIds') with ordinality requested(schedule_id,ordinality)
      where stop.route_id=route_value.id and stop.schedule_id=requested.schedule_id::uuid;

    update api.scrap_collection_routes set status='draft',operator_id=null,approved_by=null,approved_at=null
      where id=route_value.id;
    action_value := 'revised';
  elsif p_operation='reorder' then
    if coalesce(jsonb_typeof(p_command -> 'stops'),'') <> 'array'
      or jsonb_array_length(p_command -> 'stops') <> (select count(*) from api.scrap_collection_route_stops where route_id=route_value.id and active)
      or (select count(*) <> count(distinct value ->> 'scheduleId') from jsonb_array_elements(p_command -> 'stops'))
      or (select count(*) <> count(distinct value ->> 'plannedOrder') from jsonb_array_elements(p_command -> 'stops'))
      or exists(select 1 from jsonb_array_elements(p_command -> 'stops') value
        where coalesce(jsonb_typeof(value),'') <> 'object'
          or value - array['scheduleId','plannedOrder'] <> '{}'::jsonb
          or coalesce(value ->> 'scheduleId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          or coalesce(value ->> 'plannedOrder','') !~ '^[1-9]\d*$'
          or (value ->> 'plannedOrder')::integer > 500)
      or exists(select 1 from jsonb_array_elements(p_command -> 'stops') value
        where not exists(select 1 from api.scrap_collection_route_stops stop
          where stop.route_id=route_value.id and stop.active and stop.schedule_id=(value ->> 'scheduleId')::uuid)) then
      raise exception using errcode='P0001',message='VALIDATION_FAILED';
    end if;
    update api.scrap_collection_route_stops set active=false,removed_by=actor,removed_at=stamp,
      removal_reason=p_command ->> 'reason',updated_at=stamp where route_id=route_value.id and active;
    for item in select value from jsonb_array_elements(p_command -> 'stops') loop
      update api.scrap_collection_route_stops set planned_order=(item ->> 'plannedOrder')::integer,updated_at=stamp
        where route_id=route_value.id and schedule_id=(item ->> 'scheduleId')::uuid;
      if not found then raise exception using errcode='P0001',message='VALIDATION_FAILED'; end if;
    end loop;
    update api.scrap_collection_route_stops stop set active=true,removed_by=null,removed_at=null,removal_reason=null,
      updated_at=stamp where route_id=route_value.id and stop.schedule_id in
        (select (value ->> 'scheduleId')::uuid from jsonb_array_elements(p_command -> 'stops'));
    if route_value.status='assigned' then
      update api.logistics_pickups pickup set route_archived_at=stamp,route_archive_reason=p_command ->> 'reason',updated_at=stamp
        from api.scrap_collection_route_stops stop
        where stop.route_id=route_value.id and stop.active and pickup.schedule_id=stop.schedule_id;
    end if;
    if route_value.status in ('approved','assigned') then
      update api.scrap_collection_routes set status='draft',operator_id=null,approved_by=null,approved_at=null
        where id=route_value.id;
    end if;
    action_value := 'reordered';
  elsif p_operation='approve' then
    if route_value.status <> 'draft' then raise exception using errcode='P0001',message='VERSION_CONFLICT'; end if;
    update api.scrap_collection_routes set status='approved',approved_by=actor,approved_at=stamp where id=route_value.id;
    action_value := 'approved';
  else
    if route_value.status not in ('approved','assigned') or coalesce(p_command ->> 'operatorId','') !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      raise exception using errcode='P0001',message='VALIDATION_FAILED';
    end if;
    select profile.* into operator_value from api.user_profiles profile
      where profile.id=(p_command ->> 'operatorId')::uuid and profile.status='active' and profile.blocked_at is null
      and exists(select 1 from api.user_role_assignments assignment join api.roles role on role.id=assignment.role_id
        where assignment.user_id=profile.id and role.code='logistics' and assignment.revoked_at is null);
    if operator_value.id is null then raise exception using errcode='P0001',message='VALIDATION_FAILED'; end if;
    perform pg_advisory_xact_lock(hashtextextended('logistics-route:'||operator_value.id::text||':'||route_value.route_date::text,1));
    if exists(select 1 from api.scrap_collection_route_stops stop
      join api.logistics_pickups pickup on pickup.schedule_id=stop.schedule_id
      where stop.route_id=route_value.id and stop.active and pickup.result_outcome is not null) then
      raise exception using errcode='P0001',message='VERSION_CONFLICT';
    end if;
    if exists(select 1 from api.scrap_collection_route_stops stop
      join api.logistics_pickups occupied on occupied.operator_id=operator_value.id
        and occupied.route_date=route_value.route_date and occupied.route_order=stop.planned_order
        and occupied.schedule_id<>stop.schedule_id and occupied.route_archived_at is null
        where stop.route_id=route_value.id and stop.active) then
      raise exception using errcode='P0001',message='VERSION_CONFLICT';
    end if;
    old_operator := route_value.operator_id;
    for stop_value in select stop.* from api.scrap_collection_route_stops stop
      where stop.route_id=route_value.id and stop.active order by stop.planned_order loop
      select * into schedule_value from api.pickup_schedules where id=stop_value.schedule_id for update;
      select * into pickup_value from api.logistics_pickups where schedule_id=stop_value.schedule_id;
      pickup_before := private.logistics_snapshot(private.logistics_pickup_projection(schedule_value.id,false));
      if pickup_value.id is null then
        insert into api.logistics_pickups(schedule_id,promise_version,promised_weight_kg,client_name_snapshot,
          address_snapshot,document_snapshot,desired_date_snapshot,period_snapshot,observation_snapshot,
          operator_id,operator_name_snapshot,route_date,route_order,assigned_by,assigned_at)
        values(schedule_value.id,schedule_value.version,stop_value.promised_weight_kg,stop_value.client_name_snapshot,
          stop_value.address_snapshot,stop_value.document_snapshot,schedule_value.desired_date,schedule_value.period,
          schedule_value.observation,operator_value.id,operator_value.display_name,route_value.route_date,
          stop_value.planned_order,actor,stamp);
      else
        update api.logistics_pickups set operator_id=operator_value.id,operator_name_snapshot=operator_value.display_name,
          route_date=route_value.route_date,route_order=stop_value.planned_order,assigned_by=actor,assigned_at=stamp,
          route_archived_at=null,route_archive_reason=null,updated_at=stamp where schedule_id=schedule_value.id;
      end if;
      update api.pickup_schedules set version=version+1,last_event_at=stamp,updated_at=stamp where id=schedule_value.id;
      pickup_after := private.logistics_snapshot(private.logistics_pickup_projection(schedule_value.id,false));
      insert into api.logistics_pickup_events(schedule_id,actor_id,actor_name_snapshot,action,reason,before_data,
        after_data,created_at,updated_at) values(schedule_value.id,actor,identity_value ->> 'displayName','assigned',
        p_command ->> 'reason',pickup_before,pickup_after,stamp,stamp);
    end loop;
    update api.scrap_collection_routes set status='assigned',operator_id=operator_value.id where id=route_value.id;
    action_value := case when old_operator is null then 'assigned' else 'reassigned' end;
  end if;
  update api.scrap_collection_routes set version=version+1,updated_at=stamp where id=route_value.id returning * into route_value;
  response_value := private.scrap_collection_route_projection(route_value.id);
  insert into api.scrap_collection_route_events(route_id,version,actor_id,actor_name_snapshot,action,reason,before_data,after_data)
    values(route_value.id,route_value.version,actor,identity_value ->> 'displayName',action_value,p_command ->> 'reason',before_value,response_value);
  insert into private.scrap_collection_route_commands(actor_id,idempotency_key,operation,route_id,command,response)
    values(actor,p_idempotency_key,p_operation,route_value.id,p_command,response_value);
  return response_value;
end $$;

create function private.sync_scrap_collection_route_status()
returns trigger language plpgsql volatile security definer set search_path = '' as $$
declare route_value api.scrap_collection_routes%rowtype; total_count integer; completed_count integer;
  next_status text; stamp timestamptz := coalesce(new.result_at,now()); projection_value jsonb;
begin
  if old.result_outcome is not null or new.result_outcome is null then return new; end if;
  select route.* into route_value from api.scrap_collection_routes route
    join api.scrap_collection_route_stops stop on stop.route_id=route.id
    where stop.schedule_id=new.schedule_id for update of route;
  if route_value.id is null or route_value.status in ('cancelled','completed') then return new; end if;
  select count(*)::integer,count(*) filter(where pickup.result_outcome is not null)::integer
    into total_count,completed_count from api.scrap_collection_route_stops stop
    left join api.logistics_pickups pickup on pickup.schedule_id=stop.schedule_id
      where stop.route_id=route_value.id and stop.active;
  next_status := case when completed_count=total_count then 'completed' else 'in_progress' end;
  if route_value.status is distinct from next_status then
    update api.scrap_collection_routes set status=next_status,version=version+1,
      completed_at=case when next_status='completed' then stamp else null end,updated_at=stamp
      where id=route_value.id returning * into route_value;
    projection_value := private.scrap_collection_route_projection(route_value.id);
    insert into api.scrap_collection_route_events(route_id,version,actor_id,actor_name_snapshot,action,after_data,created_at)
      values(route_value.id,route_value.version,new.result_by,new.result_name_snapshot,
        case when next_status='completed' then 'completed' else 'started' end,projection_value,stamp);
  end if;
  return new;
end $$;

create or replace function api.list_logistics_pickups(p_date date)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare d jsonb:=private.resolve_current_identity(); rows jsonb; totals jsonb;
begin
  if not private.logistics_manager(d) and not private.logistics_operator(d) then
    raise exception using errcode='P0001',message='FORBIDDEN'; end if;
  if p_date is null then raise exception using errcode='P0001',message='VALIDATION_FAILED'; end if;
  with visible as materialized (
    select s.id,coalesce(l.promised_weight_kg,s.estimated_weight_kg) promised,l.actual_weight_kg,
      l.reviewed_by,l.route_order,l.operator_id,s.desired_date
    from api.pickup_schedules s left join api.logistics_pickups l on l.schedule_id=s.id
    where (private.logistics_manager(d,s.seller_id) and
      ((l.id is null and s.status='pending' and s.desired_date<=p_date)
        or (l.route_archived_at is null and l.route_date=p_date)))
      or (private.logistics_operator(d) and l.route_archived_at is null
        and l.operator_id=(d->>'id')::uuid and l.route_date=p_date)
  ) select coalesce(jsonb_agg(private.logistics_pickup_projection(id) order by route_order nulls last,operator_id,desired_date,id),'[]'),
    jsonb_build_object('promisedWeightKg',coalesce(sum(promised),0)::text,
      'collectedWeightKg',coalesce(sum(actual_weight_kg),0)::text,
      'differenceKg',coalesce(sum(actual_weight_kg-promised) filter(where actual_weight_kg is not null),0)::text,
      'pending',count(*) filter(where actual_weight_kg is null),
      'reviewRequired',count(*) filter(where actual_weight_kg<>promised and reviewed_by is null)) into rows,totals from visible;
  return jsonb_build_object('schemaVersion',1,'date',p_date,'generatedAt',clock_timestamp(),'records',rows,'totals',totals);
end $$;

create function private.guard_archived_logistics_result()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if old.route_archived_at is not null and new.result_outcome is distinct from old.result_outcome then
    raise exception using errcode='P0001',message='VERSION_CONFLICT';
  end if;
  return new;
end $$;

revoke all on function private.scrap_collection_route_manager(jsonb),private.scrap_collection_route_visible(jsonb,uuid),
  private.scrap_collection_route_projection(uuid),
  private.scrap_collection_route_recompute(uuid),private.sync_scrap_collection_route_status(),
  private.guard_archived_logistics_result()
  from public,anon,authenticated;
revoke all on function api.get_scrap_collection_route(uuid),api.list_scrap_collection_routes(date),
  api.create_scrap_collection_route(uuid,jsonb),api.change_scrap_collection_route(uuid,text,uuid,jsonb)
  from public,anon,authenticated;
grant execute on function api.get_scrap_collection_route(uuid),api.list_scrap_collection_routes(date),
  api.create_scrap_collection_route(uuid,jsonb),api.change_scrap_collection_route(uuid,text,uuid,jsonb) to authenticated;
reset role;

create trigger scrap_collection_routes_no_delete before delete on api.scrap_collection_routes
  for each row execute function private.prevent_scrap_history_delete();
create trigger scrap_collection_route_stops_no_delete before delete on api.scrap_collection_route_stops
  for each row execute function private.prevent_scrap_history_delete();
create trigger scrap_collection_route_events_no_delete before delete on api.scrap_collection_route_events
  for each row execute function private.prevent_scrap_history_delete();
create trigger scrap_collection_route_events_immutable before update on api.scrap_collection_route_events
  for each row execute function private.guard_scrap_immutable_row();
create trigger sync_scrap_collection_route_status after update of result_outcome on api.logistics_pickups
  for each row execute function private.sync_scrap_collection_route_status();
create trigger guard_archived_logistics_result before update of result_outcome on api.logistics_pickups
  for each row execute function private.guard_archived_logistics_result();

revoke create on schema api, private from cirne_scrap_executor;
do $roles$ begin
  execute format('revoke cirne_scrap_executor from %I granted by current_user',current_user);
end $roles$;
notify pgrst,'reload schema';
commit;
