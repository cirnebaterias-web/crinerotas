-- Story 3.13: durable, caller-scoped Google Sheets synchronization runs.
begin;
select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cirne:database:migrate'));
set local lock_timeout = '5s';
do $membership$
begin
  execute pg_catalog.format('grant cirne_route_executor to %I with set true granted by current_user', current_user);
end
$membership$;
grant usage,create on schema api,private to cirne_route_executor;

create table private.client_sheet_sync_runs (
  id uuid primary key default gen_random_uuid(),
  source_key text not null check (source_key ~ '^[0-9a-f]{64}$'),
  request_key text not null check (char_length(request_key) between 1 and 100),
  trigger text not null check (trigger in ('manual','scheduled')),
  requested_by uuid not null references api.user_profiles(id) on delete restrict,
  lease_token uuid not null default gen_random_uuid(),
  lease_expires_at timestamptz not null,
  status text not null check (status in ('running','completed','completed_with_pending','failed')),
  batch_id uuid references api.import_batches(id) on delete restrict,
  ignored_count integer not null default 0 check (ignored_count between 0 and 5000),
  error_code text check (error_code ~ '^[A-Z][A-Z0-9_]{0,79}$'),
  started_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (source_key, request_key),
  check ((status = 'running') = (completed_at is null)),
  check ((status in ('completed','completed_with_pending')) = (batch_id is not null))
);
create unique index client_sheet_sync_active_source_idx
  on private.client_sheet_sync_runs(source_key) where status = 'running';
create index client_sheet_sync_source_latest_idx
  on private.client_sheet_sync_runs(source_key, started_at desc, id desc);
create index client_sheet_sync_actor_latest_idx
  on private.client_sheet_sync_runs(requested_by, source_key, started_at desc, id desc);
create index client_sheet_sync_batch_idx on private.client_sheet_sync_runs(batch_id)
  where batch_id is not null;
comment on table private.client_sheet_sync_runs is
  'Story 3.13: source is opaque SHA-256; no sheet URL, credentials or raw sheet payload. Row issues remain in import_batch_rows. Terminal request keys replay; a new intent reads and reapplies the source.';

alter table private.client_sheet_sync_runs enable row level security;
alter table private.client_sheet_sync_runs force row level security;
revoke all on private.client_sheet_sync_runs from public, anon, authenticated, service_role;
alter table private.client_sheet_sync_runs owner to cirne_route_executor;
create policy client_sheet_sync_executor_all on private.client_sheet_sync_runs
  for all to cirne_route_executor using (true) with check (true);

create function private.client_sheet_sync_document(p_run_id uuid)
returns jsonb language sql stable security definer set search_path = ''
as $function$
  select jsonb_build_object(
    'id', run.id, 'sourceKey', run.source_key,
    'status', case when run.status = 'running' and run.lease_expires_at <= now()
      then 'failed' else run.status end,
    'trigger', run.trigger, 'startedAt', run.started_at,
    'completedAt', case when run.status = 'running' and run.lease_expires_at <= now()
      then run.lease_expires_at else run.completed_at end,
    'acceptedCount', coalesce(batch.accepted_count,0),
    'pendingCount', coalesce(batch.rejected_count,0),
    'ignoredCount', run.ignored_count,
    'issues', coalesce(private.client_import_batch_document(run.batch_id,false)->'issues','[]'::jsonb),
    'batchId', run.batch_id,
    'errorCode', case when run.status = 'running' and run.lease_expires_at <= now()
      then 'SYNC_LEASE_EXPIRED' else run.error_code end
  )
  from private.client_sheet_sync_runs run
  left join api.import_batches batch on batch.id = run.batch_id
  where run.id = p_run_id;
$function$;

create function api.begin_client_sheet_sync(
  p_source_key text, p_request_key text, p_trigger text default 'manual'
) returns jsonb language plpgsql volatile security definer set search_path = ''
as $function$
declare
  identity_document jsonb := private.client_import_identity();
  actor_id uuid := (identity_document->>'id')::uuid;
  run private.client_sheet_sync_runs%rowtype;
  local_time timestamp := clock_timestamp() at time zone 'America/Sao_Paulo';
begin
  if p_source_key is null or p_source_key !~ '^[0-9a-f]{64}$'
    or p_request_key is null or char_length(p_request_key) not between 1 and 100
    or p_trigger is null or p_trigger not in ('manual','scheduled') then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  if p_trigger = 'manual' and p_request_key !~
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  if p_trigger = 'scheduled' and p_request_key !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}@(06|13):00$' then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('cirne:client-sheet-sync:' || p_source_key,0)) then
    raise exception using errcode = 'P0001', message = 'SYNC_BUSY';
  end if;

  -- Expiration and acquisition share the source lock. An expired worker cannot finish.
  update private.client_sheet_sync_runs set status = 'failed',
    error_code = 'SYNC_LEASE_EXPIRED', completed_at = lease_expires_at,
    updated_at = clock_timestamp()
  where source_key = p_source_key and status = 'running' and lease_expires_at <= clock_timestamp();
  select * into run from private.client_sheet_sync_runs
  where source_key = p_source_key and request_key = p_request_key;
  if found then
    if run.requested_by <> actor_id then
      raise exception using errcode = 'P0001', message = 'NOT_FOUND';
    end if;
    if run.trigger <> p_trigger then
      raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
    end if;
    return jsonb_build_object('runId',run.id,'leaseToken',null,'replayed',true,
      'result',private.client_sheet_sync_document(run.id));
  end if;
  -- Replays remain recoverable after the slot. New scheduled intentions only run
  -- in their local hour, allowing bounded cron retries without adding extra slots.
  if p_trigger = 'scheduled' and (
    extract(hour from local_time) not in (6,13)
    or p_request_key <> to_char(local_time,'YYYY-MM-DD@HH24:') || '00'
  ) then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  if exists(select 1 from private.client_sheet_sync_runs
    where source_key = p_source_key and status = 'running') then
    raise exception using errcode = 'P0001', message = 'SYNC_BUSY';
  end if;
  insert into private.client_sheet_sync_runs
    (source_key,request_key,trigger,requested_by,lease_expires_at,status)
  values (p_source_key,p_request_key,p_trigger,actor_id,clock_timestamp()+interval '10 minutes','running')
  returning * into run;
  return jsonb_build_object('runId',run.id,'leaseToken',run.lease_token,'replayed',false,
    'result',private.client_sheet_sync_document(run.id));
end
$function$;

create function api.finish_client_sheet_sync(
  p_run_id uuid, p_lease_token uuid, p_command jsonb,
  p_ignored_count integer default 0, p_origin text default 'web'
) returns jsonb language plpgsql volatile security definer set search_path = ''
as $function$
declare
  identity_document jsonb := private.client_import_identity();
  actor_id uuid := (identity_document->>'id')::uuid;
  run private.client_sheet_sync_runs%rowtype;
  command jsonb;
  batch jsonb;
  run_checksum text;
begin
  select * into run from private.client_sheet_sync_runs where id = p_run_id for update;
  if not found or run.requested_by <> actor_id
    or p_lease_token is null or run.lease_token <> p_lease_token then
    raise exception using errcode = 'P0001', message = 'NOT_FOUND';
  end if;
  if run.status <> 'running' then
    return private.client_sheet_sync_document(run.id);
  end if;
  if run.lease_expires_at <= clock_timestamp() then
    raise exception using errcode = 'P0001', message = 'SYNC_LEASE_EXPIRED';
  end if;
  if p_ignored_count is null or p_ignored_count not between 0 and 5000
    or p_command is null or jsonb_typeof(p_command) is distinct from 'object'
    or coalesce(p_command->>'sourceChecksum','') !~ '^[0-9a-f]{64}$'
    or coalesce(p_command->>'totalCount','') !~ '^[0-9]+$'
    or (p_command->>'totalCount')::numeric + p_ignored_count > 5000 then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  -- A different run must be able to reapply an unchanged source after manual edits.
  -- The supplied checksum includes normalized content and mapping configuration.
  run_checksum := encode(extensions.digest(convert_to(jsonb_build_array(
    'client-sheet-sync-v1',run.source_key,run.request_key,p_command->>'sourceChecksum'
  )::text,'UTF8'),'sha256'),'hex');
  command := jsonb_set(p_command,'{sourceChecksum}',to_jsonb(run_checksum));
  batch := api.execute_client_import(command,p_origin);
  update private.client_sheet_sync_runs set
    status = case when (batch->>'rejectedCount')::integer > 0
      then 'completed_with_pending' else 'completed' end,
    batch_id = (batch->>'id')::uuid, ignored_count = p_ignored_count,
    completed_at = clock_timestamp(), updated_at = clock_timestamp(), error_code = null
  where id = run.id;
  return private.client_sheet_sync_document(run.id);
end
$function$;

create function api.fail_client_sheet_sync(p_run_id uuid,p_lease_token uuid,p_error_code text)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $function$
declare
  identity_document jsonb := private.client_import_identity();
  actor_id uuid := (identity_document->>'id')::uuid;
  run private.client_sheet_sync_runs%rowtype;
begin
  select * into run from private.client_sheet_sync_runs where id = p_run_id for update;
  if not found or run.requested_by <> actor_id
    or p_lease_token is null or run.lease_token <> p_lease_token then
    raise exception using errcode = 'P0001', message = 'NOT_FOUND';
  end if;
  if run.status <> 'running' then
    return private.client_sheet_sync_document(run.id);
  end if;
  if p_error_code is null or p_error_code !~ '^[A-Z][A-Z0-9_]{0,79}$' then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  update private.client_sheet_sync_runs set status = 'failed', error_code = p_error_code,
    completed_at = clock_timestamp(), updated_at = clock_timestamp()
  where id = run.id;
  return private.client_sheet_sync_document(run.id);
end
$function$;

create function api.get_client_sheet_sync_status(p_source_key text)
returns jsonb language plpgsql stable security definer set search_path = ''
as $function$
declare
  identity_document jsonb := private.client_import_identity();
  actor_id uuid := (identity_document->>'id')::uuid;
  run_id uuid;
begin
  if p_source_key is null or p_source_key !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  select id into run_id from private.client_sheet_sync_runs
  where source_key = p_source_key
    and (requested_by = actor_id or identity_document->'roles' ? 'administrator')
  order by started_at desc,id desc limit 1;
  return private.client_sheet_sync_document(run_id);
end
$function$;

alter function private.client_sheet_sync_document(uuid) owner to cirne_route_executor;
alter function api.begin_client_sheet_sync(text,text,text) owner to cirne_route_executor;
alter function api.finish_client_sheet_sync(uuid,uuid,jsonb,integer,text) owner to cirne_route_executor;
alter function api.fail_client_sheet_sync(uuid,uuid,text) owner to cirne_route_executor;
alter function api.get_client_sheet_sync_status(text) owner to cirne_route_executor;
revoke all on function private.client_sheet_sync_document(uuid) from public,anon,authenticated,service_role;
revoke all on function api.begin_client_sheet_sync(text,text,text),
  api.finish_client_sheet_sync(uuid,uuid,jsonb,integer,text),
  api.fail_client_sheet_sync(uuid,uuid,text),api.get_client_sheet_sync_status(text) from public,anon;
grant execute on function api.begin_client_sheet_sync(text,text,text),
  api.finish_client_sheet_sync(uuid,uuid,jsonb,integer,text),
  api.fail_client_sheet_sync(uuid,uuid,text),api.get_client_sheet_sync_status(text)
  to authenticated,service_role;
revoke create on schema api,private from cirne_route_executor;

do $membership$
begin
  execute pg_catalog.format('revoke cirne_route_executor from %I granted by current_user', current_user);
end
$membership$;

commit;
