-- Story 3.13 / ADR 005: database-enforced scheduler identity per source.
-- Intentionally empty by default. Only privileged DB administration provisions it.
-- Operational rollback: stop scheduled jobs and retain this authorization boundary.
begin;
select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cirne:database:migrate'));
set local lock_timeout = '5s';
do $membership$
begin
  execute pg_catalog.format('grant cirne_route_executor to %I with set true granted by current_user',current_user);
end
$membership$;
grant usage,create on schema api,private to cirne_route_executor;

create table private.client_sheet_sync_sources (
  source_key text primary key check (source_key ~ '^[0-9a-f]{64}$'),
  scheduler_actor_id uuid not null references api.user_profiles(id) on delete restrict
);
create index client_sheet_sync_sources_scheduler_idx
  on private.client_sheet_sync_sources(scheduler_actor_id);
comment on table private.client_sheet_sync_sources is
  'Private DB-admin-only allowlist binding an opaque source SHA-256 to one scheduler actor. No automatic registration or public configuration RPC. Missing binding denies scheduled execution.';
alter table private.client_sheet_sync_sources enable row level security;
alter table private.client_sheet_sync_sources force row level security;
revoke all on private.client_sheet_sync_sources from public,anon,authenticated,service_role;
alter table private.client_sheet_sync_sources owner to cirne_route_executor;
create policy client_sheet_sync_sources_executor_read on private.client_sheet_sync_sources
  for select to cirne_route_executor using (true);
-- PostgreSQL row locking also checks UPDATE visibility. USING admits FOR SHARE,
-- while WITH CHECK false rejects every actual new row version. No INSERT/DELETE
-- policy exists; the executor can lock configuration but cannot provision it.
create policy client_sheet_sync_sources_executor_lock on private.client_sheet_sync_sources
  for update to cirne_route_executor using (true) with check (false);

create or replace function api.begin_client_sheet_sync(
  p_source_key text,p_request_key text,p_trigger text default 'manual'
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
  -- Check the configured actor before replay, lease expiration, locks or slot checks.
  -- A manager or administrator with clients.import is not implicitly the scheduler.
  if p_trigger = 'scheduled' then
    perform 1 from private.client_sheet_sync_sources
    where source_key=p_source_key and scheduler_actor_id=actor_id for share;
    if not found then
      raise exception using errcode = 'P0001', message = 'FORBIDDEN';
    end if;
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
  update private.client_sheet_sync_runs set status='failed',
    error_code='SYNC_LEASE_EXPIRED',completed_at=lease_expires_at,updated_at=clock_timestamp()
  where source_key=p_source_key and status='running' and lease_expires_at<=clock_timestamp();
  select * into run from private.client_sheet_sync_runs
  where source_key=p_source_key and request_key=p_request_key;
  if found then
    if run.requested_by<>actor_id then
      raise exception using errcode = 'P0001', message = 'NOT_FOUND';
    end if;
    if run.trigger<>p_trigger then
      raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
    end if;
    return jsonb_build_object('runId',run.id,'leaseToken',null,'replayed',true,
      'result',private.client_sheet_sync_document(run.id));
  end if;
  if p_trigger='scheduled' and (
    extract(hour from local_time) not in (6,13)
    or p_request_key<>to_char(local_time,'YYYY-MM-DD@HH24:') || '00'
  ) then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  if exists(select 1 from private.client_sheet_sync_runs
    where source_key=p_source_key and status='running') then
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

create or replace function api.finish_client_sheet_sync(
  p_run_id uuid,p_lease_token uuid,p_command jsonb,
  p_ignored_count integer default 0,p_origin text default 'web'
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
  select * into run from private.client_sheet_sync_runs where id=p_run_id for update;
  if not found or run.requested_by<>actor_id
    or p_lease_token is null or run.lease_token<>p_lease_token then
    raise exception using errcode = 'P0001', message = 'NOT_FOUND';
  end if;
  -- Revalidate after the external fetch. A revoked/reassigned actor cannot finish.
  -- The shared lock makes configuration changes wait until this atomic import ends.
  if run.trigger='scheduled' then
    perform 1 from private.client_sheet_sync_sources
    where source_key=run.source_key and scheduler_actor_id=actor_id for share;
    if not found then
      raise exception using errcode = 'P0001', message = 'FORBIDDEN';
    end if;
  end if;
  if run.status<>'running' then
    return private.client_sheet_sync_document(run.id);
  end if;
  if run.lease_expires_at<=clock_timestamp() then
    raise exception using errcode = 'P0001', message = 'SYNC_LEASE_EXPIRED';
  end if;
  if p_ignored_count is null or p_ignored_count not between 0 and 5000
    or p_command is null or jsonb_typeof(p_command) is distinct from 'object'
    or coalesce(p_command->>'sourceChecksum','') !~ '^[0-9a-f]{64}$'
    or coalesce(p_command->>'totalCount','') !~ '^[0-9]+$'
    or (p_command->>'totalCount')::numeric+p_ignored_count>5000 then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  run_checksum:=encode(extensions.digest(convert_to(jsonb_build_array(
    'client-sheet-sync-v1',run.source_key,run.request_key,p_command->>'sourceChecksum'
  )::text,'UTF8'),'sha256'),'hex');
  command:=jsonb_set(p_command,'{sourceChecksum}',to_jsonb(run_checksum));
  batch:=api.execute_client_import(command,p_origin);
  update private.client_sheet_sync_runs set
    status=case when (batch->>'rejectedCount')::integer>0 then 'completed_with_pending' else 'completed' end,
    batch_id=(batch->>'id')::uuid,ignored_count=p_ignored_count,
    completed_at=clock_timestamp(),updated_at=clock_timestamp(),error_code=null
  where id=run.id;
  return private.client_sheet_sync_document(run.id);
end
$function$;

alter function api.begin_client_sheet_sync(text,text,text) owner to cirne_route_executor;
alter function api.finish_client_sheet_sync(uuid,uuid,jsonb,integer,text) owner to cirne_route_executor;
revoke all on function api.begin_client_sheet_sync(text,text,text),
  api.finish_client_sheet_sync(uuid,uuid,jsonb,integer,text) from public,anon;
grant execute on function api.begin_client_sheet_sync(text,text,text),
  api.finish_client_sheet_sync(uuid,uuid,jsonb,integer,text) to authenticated,service_role;
revoke create on schema api,private from cirne_route_executor;
do $membership$
begin
  execute pg_catalog.format('revoke cirne_route_executor from %I granted by current_user',current_user);
end
$membership$;
commit;
