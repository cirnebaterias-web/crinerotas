begin;

do $preflight$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'cirne_route_executor') then
    raise exception 'Route foundation expects cirne_route_executor role to be absent';
  end if;
  if to_regclass('api.clients') is not null or to_regclass('api.routes') is not null then
    raise exception 'Route foundation expects client/route tables to be absent';
  end if;
end
$preflight$;

create extension if not exists postgis with schema extensions;

create role cirne_route_executor
  nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;

insert into api.role_permissions (role_id, permission_code)
values
  ('00000000-0000-4000-8000-000000000001', 'route.read_self'),
  ('00000000-0000-4000-8000-000000000002', 'route.plan_scoped'),
  ('00000000-0000-4000-8000-000000000002', 'route.read_scoped')
on conflict (role_id, permission_code) do nothing;

create table api.clients (
  id uuid primary key default gen_random_uuid(),
  external_reference text,
  name text not null check (char_length(btrim(name)) between 1 and 160),
  address text not null check (char_length(btrim(address)) between 1 and 300),
  location extensions.geography(point, 4326),
  portfolio_reference text,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_from_import_batch_id uuid,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint clients_external_reference_key unique (external_reference),
  constraint clients_archive_status_check check (archived_at is null or status = 'inactive')
);

create table api.routes (
  id uuid primary key default gen_random_uuid(),
  service_date date not null,
  seller_id uuid not null references api.user_profiles(id) on delete restrict,
  status text not null default 'draft'
    check (status in ('draft', 'published', 'in_progress', 'closed', 'cancelled')),
  lock_version integer not null default 1 check (lock_version > 0),
  created_by uuid not null references api.user_profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint routes_seller_service_date_key unique (seller_id, service_date)
);

create table api.route_versions (
  id uuid primary key default gen_random_uuid(),
  route_id uuid not null references api.routes(id) on delete restrict,
  version_number integer not null check (version_number > 0),
  status text not null default 'draft' check (status in ('draft', 'published', 'superseded')),
  seller_context_snapshot jsonb,
  published_by uuid references api.user_profiles(id) on delete restrict,
  published_at timestamptz,
  superseded_at timestamptz,
  created_by uuid not null references api.user_profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint route_versions_route_number_key unique (route_id, version_number),
  constraint route_versions_publication_check check (
    (status = 'draft' and published_by is null and published_at is null and seller_context_snapshot is null)
    or
    (status in ('published', 'superseded') and published_by is not null and published_at is not null
      and seller_context_snapshot is not null)
  )
);

create table api.route_version_stops (
  id uuid primary key default gen_random_uuid(),
  route_version_id uuid not null references api.route_versions(id) on delete restrict,
  client_id uuid not null references api.clients(id) on delete restrict,
  planned_order integer not null check (planned_order between 1 and 50),
  priority integer not null check (priority between 0 and 9),
  client_context_snapshot jsonb,
  created_at timestamptz not null default now(),
  constraint route_version_stops_id_version_key unique (id, route_version_id),
  constraint route_version_stops_client_key unique (route_version_id, client_id),
  constraint route_version_stops_order_key unique (route_version_id, planned_order)
);

create table api.route_stop_executions (
  id uuid primary key default gen_random_uuid(),
  route_version_id uuid not null references api.route_versions(id) on delete restrict,
  route_version_stop_id uuid not null unique,
  execution_order integer not null check (execution_order between 1 and 50),
  status text not null default 'pending'
    check (status in ('pending', 'in_visit', 'completed', 'not_visited')),
  non_visit_reason_id uuid,
  lock_version integer not null default 1 check (lock_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint route_stop_executions_stop_version_fkey
    foreign key (route_version_stop_id, route_version_id)
    references api.route_version_stops(id, route_version_id) on delete restrict,
  constraint route_stop_executions_order_key unique (route_version_id, execution_order),
  constraint route_stop_executions_reason_check check (
    (status = 'not_visited' and non_visit_reason_id is not null)
    or (status <> 'not_visited' and non_visit_reason_id is null)
  )
);

create unique index route_versions_current_published_key
  on api.route_versions (route_id)
  where status = 'published' and superseded_at is null;
create index routes_seller_service_date_idx on api.routes (seller_id, service_date);
create index route_versions_route_number_idx on api.route_versions (route_id, version_number desc);
create index route_version_stops_route_order_idx on api.route_version_stops (route_version_id, planned_order);
create index route_stop_executions_status_order_idx on api.route_stop_executions (status, execution_order);
create index clients_lower_name_idx on api.clients (lower(name));
create index clients_location_idx on api.clients using gist (location);

create trigger clients_set_updated_at
before update on api.clients
for each row execute function private.set_updated_at();
create trigger routes_set_updated_at
before update on api.routes
for each row execute function private.set_updated_at();
create trigger route_stop_executions_set_updated_at
before update on api.route_stop_executions
for each row execute function private.set_updated_at();

alter table api.clients enable row level security;
alter table api.clients force row level security;
alter table api.routes enable row level security;
alter table api.routes force row level security;
alter table api.route_versions enable row level security;
alter table api.route_versions force row level security;
alter table api.route_version_stops enable row level security;
alter table api.route_version_stops force row level security;
alter table api.route_stop_executions enable row level security;
alter table api.route_stop_executions force row level security;

create policy clients_route_executor_all on api.clients
  for all to cirne_route_executor using (true) with check (true);
create policy routes_route_executor_all on api.routes
  for all to cirne_route_executor using (true) with check (true);
create policy route_versions_route_executor_all on api.route_versions
  for all to cirne_route_executor using (true) with check (true);
create policy route_version_stops_route_executor_all on api.route_version_stops
  for all to cirne_route_executor using (true) with check (true);
create policy route_stop_executions_route_executor_all on api.route_stop_executions
  for all to cirne_route_executor using (true) with check (true);
create policy user_profiles_route_executor_read on api.user_profiles
  for select to cirne_route_executor using (true);

revoke all on table api.clients, api.routes, api.route_versions,
  api.route_version_stops, api.route_stop_executions from public, anon, authenticated;
grant usage, create on schema api, private to cirne_route_executor;
grant usage on schema extensions to cirne_route_executor;
grant select on table api.user_profiles to cirne_route_executor;
grant select, insert, update on table api.clients to service_role;

do $audit_ownership$
begin
  execute pg_catalog.format('grant cirne_sync_executor to %I with set true granted by current_user', current_user);
end
$audit_ownership$;
set local role cirne_sync_executor;
grant insert on table private.audit_events to cirne_route_executor;
reset role;
do $audit_ownership$
begin
  execute pg_catalog.format('revoke cirne_sync_executor from %I granted by current_user', current_user);
end
$audit_ownership$;

do $identity_ownership$
begin
  execute pg_catalog.format('grant cirne_identity_executor to %I with set true granted by current_user', current_user);
end
$identity_ownership$;
set local role cirne_identity_executor;
grant execute on function private.resolve_current_identity() to cirne_route_executor;
reset role;
do $identity_ownership$
begin
  execute pg_catalog.format('revoke cirne_identity_executor from %I granted by current_user', current_user);
end
$identity_ownership$;

create function private.route_identity(p_capability text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  identity_document jsonb := private.resolve_current_identity();
begin
  if identity_document is null
     or not (identity_document -> 'capabilities' @> jsonb_build_array(p_capability)) then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;
  return identity_document;
end
$function$;

create function private.guard_published_route_version()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if old.status = 'superseded' then
    raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT';
  end if;
  if tg_op = 'DELETE' and old.status = 'published' then
    raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT';
  end if;
  if tg_op = 'UPDATE' and old.status = 'published' and not (
    new.status = 'superseded'
    and old.superseded_at is null
    and new.superseded_at is not null
    and (to_jsonb(new) - 'status' - 'superseded_at') =
        (to_jsonb(old) - 'status' - 'superseded_at')
  ) then
    raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end
$function$;

create trigger route_versions_guard_published
before update or delete on api.route_versions
for each row execute function private.guard_published_route_version();

create function private.guard_published_route_stop()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  target_version_id uuid := case when tg_op = 'DELETE' then old.route_version_id else new.route_version_id end;
begin
  if exists (
    select 1 from api.route_versions version_row
    where version_row.id = target_version_id and version_row.status in ('published', 'superseded')
  ) then
    raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end
$function$;

create trigger route_version_stops_guard_published
before insert or update or delete on api.route_version_stops
for each row execute function private.guard_published_route_stop();

create function private.create_route_draft(p_command jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  identity_document jsonb := private.route_identity('route.plan_scoped');
  actor_id uuid := (identity_document ->> 'id')::uuid;
  v_seller_id uuid;
  v_service_date date;
  v_route_id uuid := gen_random_uuid();
  v_route_version_id uuid := gen_random_uuid();
  stops jsonb;
  stop_count integer;
  result_document jsonb;
begin
  if p_command is null or jsonb_typeof(p_command) <> 'object'
     or not (p_command ?& array['schemaVersion', 'serviceDate', 'sellerId', 'stops'])
     or (select count(*) from jsonb_object_keys(p_command)) <> 4
     or p_command ->> 'schemaVersion' <> '1'
     or jsonb_typeof(p_command -> 'stops') <> 'array' then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;

  begin
    v_seller_id := (p_command ->> 'sellerId')::uuid;
    v_service_date := (p_command ->> 'serviceDate')::date;
  exception when invalid_text_representation or datetime_field_overflow then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end;
  if p_command ->> 'serviceDate' <> to_char(v_service_date, 'YYYY-MM-DD') then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;

  stops := p_command -> 'stops';
  stop_count := jsonb_array_length(stops);
  if stop_count < 1 or stop_count > 50
     or exists (
       select 1
       from jsonb_array_elements(stops) stop
       where jsonb_typeof(stop) <> 'object'
          or not (stop ?& array['clientId', 'plannedOrder', 'priority'])
          or (select count(*) from jsonb_object_keys(stop)) <> 3
          or jsonb_typeof(stop -> 'clientId') <> 'string'
          or jsonb_typeof(stop -> 'plannedOrder') <> 'number'
          or jsonb_typeof(stop -> 'priority') <> 'number'
          or stop ->> 'plannedOrder' !~ '^[0-9]+$'
          or stop ->> 'priority' !~ '^[0-9]+$'
          or (stop ->> 'plannedOrder')::integer not between 1 and 50
          or (stop ->> 'priority')::integer not between 0 and 9
     ) then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;

  begin
    if (select count(distinct (stop ->> 'clientId')::uuid) from jsonb_array_elements(stops) stop) <> stop_count
       or (select count(distinct (stop ->> 'plannedOrder')::integer) from jsonb_array_elements(stops) stop) <> stop_count then
      raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
    end if;
  exception when invalid_text_representation then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end;

  if not exists (
    select 1 from jsonb_array_elements_text(identity_document -> 'scopeIds') scope_id
    where scope_id::uuid = v_seller_id
  ) or not exists (
    select 1 from api.user_profiles profile
    where profile.id = v_seller_id and profile.status = 'active' and profile.blocked_at is null
  ) then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;

  if (
    select count(*)
    from api.clients client
    where client.id in (select (stop ->> 'clientId')::uuid from jsonb_array_elements(stops) stop)
      and client.status = 'active' and client.archived_at is null
  ) <> stop_count then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;

  begin
    insert into api.routes (id, service_date, seller_id, status, lock_version, created_by)
    values (v_route_id, v_service_date, v_seller_id, 'draft', 1, actor_id);

    insert into api.route_versions (id, route_id, version_number, status, created_by)
    values (v_route_version_id, v_route_id, 1, 'draft', actor_id);

    insert into api.route_version_stops (
      route_version_id, client_id, planned_order, priority
    )
    select
      v_route_version_id,
      (stop ->> 'clientId')::uuid,
      (stop ->> 'plannedOrder')::integer,
      (stop ->> 'priority')::integer
    from jsonb_array_elements(stops) stop;
  exception when unique_violation then
    raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT';
  end;

  select jsonb_build_object(
    'schemaVersion', 1,
    'routeId', v_route_id,
    'routeVersionId', v_route_version_id,
    'versionNumber', 1,
    'expectedVersion', 1,
    'serviceDate', v_service_date,
    'sellerId', v_seller_id,
    'status', 'draft',
    'stops', jsonb_agg(jsonb_build_object(
      'routeVersionStopId', stop_row.id,
      'clientId', stop_row.client_id,
      'plannedOrder', stop_row.planned_order,
      'priority', stop_row.priority
    ) order by stop_row.planned_order)
  )
  into result_document
  from api.route_version_stops stop_row
  where stop_row.route_version_id = v_route_version_id;

  insert into private.audit_events (
    actor_id, target_type, target_id, action, after_data, origin
  ) values (
    actor_id, 'route', v_route_id, 'route.draft.created',
    jsonb_build_object(
      'routeId', v_route_id,
      'routeVersionId', v_route_version_id,
      'serviceDate', v_service_date,
      'sellerId', v_seller_id,
      'stopCount', stop_count
    ),
    'system'
  );

  return result_document;
end
$function$;

create function private.publish_route(p_route_id uuid, p_expected_version integer)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  identity_document jsonb := private.route_identity('route.plan_scoped');
  actor_id uuid := (identity_document ->> 'id')::uuid;
  route_row api.routes%rowtype;
  route_version_row api.route_versions%rowtype;
  publication_time timestamptz := clock_timestamp();
  seller_snapshot jsonb;
  stop_count integer;
  result_document jsonb;
begin
  if p_route_id is null or p_expected_version is null or p_expected_version < 1 then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;

  select * into route_row from api.routes where id = p_route_id for update;
  if not found or not exists (
    select 1 from jsonb_array_elements_text(identity_document -> 'scopeIds') scope_id
    where scope_id::uuid = route_row.seller_id
  ) then
    raise exception using errcode = 'P0001', message = 'NOT_FOUND';
  end if;
  if route_row.lock_version <> p_expected_version or route_row.status <> 'draft' then
    raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT';
  end if;

  select * into route_version_row
  from api.route_versions
  where route_id = p_route_id and status = 'draft'
  order by version_number desc
  limit 1
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT';
  end if;

  select jsonb_build_object('id', profile.id, 'displayName', profile.display_name)
  into seller_snapshot
  from api.user_profiles profile
  where profile.id = route_row.seller_id and profile.status = 'active' and profile.blocked_at is null;
  if seller_snapshot is null then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;

  update api.route_version_stops stop_row
  set client_context_snapshot = jsonb_build_object(
    'id', client.id,
    'externalReference', client.external_reference,
    'name', client.name,
    'address', client.address,
    'latitude', case when client.location is null then null
      else extensions.st_y(client.location::extensions.geometry)::text end,
    'longitude', case when client.location is null then null
      else extensions.st_x(client.location::extensions.geometry)::text end,
    'portfolioReference', client.portfolio_reference
  )
  from api.clients client
  where stop_row.route_version_id = route_version_row.id
    and client.id = stop_row.client_id
    and client.status = 'active'
    and client.archived_at is null;

  select count(*) into stop_count
  from api.route_version_stops stop_row
  where stop_row.route_version_id = route_version_row.id
    and stop_row.client_context_snapshot is not null;
  if stop_count < 1 or stop_count <> (
    select count(*) from api.route_version_stops where route_version_id = route_version_row.id
  ) then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;

  update api.route_versions
  set status = 'published', seller_context_snapshot = seller_snapshot,
      published_by = actor_id, published_at = publication_time
  where id = route_version_row.id and status = 'draft';
  if not found then
    raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT';
  end if;

  insert into api.route_stop_executions (
    route_version_id, route_version_stop_id, execution_order, status, lock_version
  )
  select route_version_row.id, stop_row.id, stop_row.planned_order, 'pending', 1
  from api.route_version_stops stop_row
  where stop_row.route_version_id = route_version_row.id;

  update api.routes
  set status = 'published', lock_version = lock_version + 1
  where id = p_route_id and lock_version = p_expected_version and status = 'draft';
  if not found then
    raise exception using errcode = 'P0001', message = 'VERSION_CONFLICT';
  end if;

  result_document := jsonb_build_object(
    'schemaVersion', 1,
    'routeId', p_route_id,
    'routeVersionId', route_version_row.id,
    'versionNumber', route_version_row.version_number,
    'expectedVersion', p_expected_version + 1,
    'status', 'published',
    'publishedBy', actor_id,
    'publishedAt', publication_time,
    'stopCount', stop_count
  );

  insert into private.audit_events (
    actor_id, target_type, target_id, action, before_data, after_data, origin
  ) values (
    actor_id, 'route', p_route_id, 'route.published',
    jsonb_build_object('status', 'draft', 'expectedVersion', p_expected_version),
    result_document,
    'system'
  );

  return result_document;
end
$function$;

create function private.build_route_document(p_route_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select jsonb_build_object(
    'schemaVersion', 1,
    'routeId', route_row.id,
    'routeVersionId', version_row.id,
    'versionNumber', version_row.version_number,
    'serviceDate', route_row.service_date,
    'status', 'published',
    'publishedAt', version_row.published_at,
    'seller', version_row.seller_context_snapshot,
    'stops', jsonb_agg(jsonb_build_object(
      'routeVersionStopId', stop_row.id,
      'plannedOrder', stop_row.planned_order,
      'executionOrder', execution_row.execution_order,
      'priority', stop_row.priority,
      'status', execution_row.status,
      'executionVersion', execution_row.lock_version,
      'client', stop_row.client_context_snapshot
    ) order by stop_row.planned_order)
  )
  from api.routes route_row
  join api.route_versions version_row on version_row.route_id = route_row.id
    and version_row.status = 'published' and version_row.superseded_at is null
  join api.route_version_stops stop_row on stop_row.route_version_id = version_row.id
  join api.route_stop_executions execution_row on execution_row.route_version_stop_id = stop_row.id
  where route_row.id = p_route_id
  group by route_row.id, version_row.id;
$function$;

create function private.get_route(p_route_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  identity_document jsonb := private.resolve_current_identity();
  route_row api.routes%rowtype;
  can_read boolean := false;
  result_document jsonb;
begin
  if identity_document is null then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;
  select * into route_row from api.routes where id = p_route_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'NOT_FOUND';
  end if;

  can_read := (
    identity_document -> 'capabilities' @> '["route.read_self"]'::jsonb
    and (identity_document ->> 'id')::uuid = route_row.seller_id
  ) or (
    identity_document -> 'capabilities' @> '["route.read_scoped"]'::jsonb
    and exists (
      select 1 from jsonb_array_elements_text(identity_document -> 'scopeIds') scope_id
      where scope_id::uuid = route_row.seller_id
    )
  );
  if not can_read then
    raise exception using errcode = 'P0001', message = 'NOT_FOUND';
  end if;

  result_document := private.build_route_document(p_route_id);
  if result_document is null then
    raise exception using errcode = 'P0001', message = 'NOT_FOUND';
  end if;
  return result_document;
end
$function$;

create function private.get_my_route_for_date(p_service_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  identity_document jsonb := private.route_identity('route.read_self');
  actor_id uuid := (identity_document ->> 'id')::uuid;
  route_id uuid;
begin
  if p_service_date is null then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  select route_row.id into route_id
  from api.routes route_row
  where route_row.seller_id = actor_id
    and route_row.service_date = p_service_date
    and route_row.status = 'published';

  if route_id is null then
    return jsonb_build_object(
      'schemaVersion', 1,
      'availability', 'empty',
      'serviceDate', p_service_date
    );
  end if;
  return jsonb_build_object(
    'schemaVersion', 1,
    'availability', 'available',
    'route', private.build_route_document(route_id)
  );
end
$function$;

create function api.create_route_draft(p_command jsonb)
returns jsonb language sql volatile security definer set search_path = ''
as $function$ select private.create_route_draft(p_command); $function$;

create function api.publish_route(p_route_id uuid, p_expected_version integer)
returns jsonb language sql volatile security definer set search_path = ''
as $function$ select private.publish_route(p_route_id, p_expected_version); $function$;

create function api.get_route(p_route_id uuid)
returns jsonb language sql stable security definer set search_path = ''
as $function$ select private.get_route(p_route_id); $function$;

create function api.get_my_route_for_date(p_service_date date)
returns jsonb language sql stable security definer set search_path = ''
as $function$ select private.get_my_route_for_date(p_service_date); $function$;

comment on function api.create_route_draft(jsonb) is 'Cria a primeira versão em rascunho sob escopo gerencial.';
comment on function api.publish_route(uuid, integer) is 'Publica a rota com versão esperada e snapshots imutáveis.';
comment on function api.get_route(uuid) is 'Consulta uma rota publicada dentro do escopo vigente.';
comment on function api.get_my_route_for_date(date) is 'Carrega a rota publicada do Vendedor para a data operacional.';

do $ownership$
begin
  execute pg_catalog.format('grant cirne_route_executor to %I with set true granted by current_user', current_user);
end
$ownership$;

alter table api.clients owner to cirne_route_executor;
alter table api.routes owner to cirne_route_executor;
alter table api.route_versions owner to cirne_route_executor;
alter table api.route_version_stops owner to cirne_route_executor;
alter table api.route_stop_executions owner to cirne_route_executor;
alter function private.route_identity(text) owner to cirne_route_executor;
alter function private.guard_published_route_version() owner to cirne_route_executor;
alter function private.guard_published_route_stop() owner to cirne_route_executor;
alter function private.create_route_draft(jsonb) owner to cirne_route_executor;
alter function private.publish_route(uuid, integer) owner to cirne_route_executor;
alter function private.build_route_document(uuid) owner to cirne_route_executor;
alter function private.get_route(uuid) owner to cirne_route_executor;
alter function private.get_my_route_for_date(date) owner to cirne_route_executor;
alter function api.create_route_draft(jsonb) owner to cirne_route_executor;
alter function api.publish_route(uuid, integer) owner to cirne_route_executor;
alter function api.get_route(uuid) owner to cirne_route_executor;
alter function api.get_my_route_for_date(date) owner to cirne_route_executor;

revoke create on schema api, private from cirne_route_executor;
set local role cirne_route_executor;
revoke all on function private.route_identity(text), private.guard_published_route_version(),
  private.guard_published_route_stop(), private.create_route_draft(jsonb),
  private.publish_route(uuid, integer), private.build_route_document(uuid),
  private.get_route(uuid), private.get_my_route_for_date(date)
  from public, anon, authenticated;
revoke all on function api.create_route_draft(jsonb), api.publish_route(uuid, integer),
  api.get_route(uuid), api.get_my_route_for_date(date) from public, anon;
grant execute on function api.create_route_draft(jsonb), api.publish_route(uuid, integer),
  api.get_route(uuid), api.get_my_route_for_date(date) to authenticated;
reset role;

do $ownership$
begin
  execute pg_catalog.format('revoke cirne_route_executor from %I granted by current_user', current_user);
end
$ownership$;

commit;
