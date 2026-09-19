-- Story 3.2: enforce the direct RPC contract and private stock helper ACL.
-- Recovery uses the coordinated stock-capability rollback; do not restore public EXECUTE.
begin;
select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cirne:database:migrate'));
set local lock_timeout = '5s';

do $preflight$
begin
  if to_regprocedure('private.save_visit_stock(uuid,uuid,jsonb)') is null
     or to_regprocedure('private.sync_event(uuid,jsonb)') is null then
    raise exception 'Visit stock lock-order hardening requires the stock functions';
  end if;
end
$preflight$;

do $sync_ownership$
begin
  execute pg_catalog.format('grant cirne_sync_executor to %I with set true granted by current_user', current_user);
end
$sync_ownership$;
grant create on schema private to cirne_sync_executor;
set local role cirne_sync_executor;

create or replace function private.save_visit_stock(
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
  identity_document jsonb := private.resolve_current_identity();
  v_actor_id uuid := (identity_document ->> 'id')::uuid;
  v_offline_id uuid;
  v_event_id uuid;
  v_sequence integer;
  previous_event private.sync_events%rowtype;
  sync_result jsonb;
begin
  if identity_document is null
     or not (identity_document -> 'capabilities' @> '["visit.start_self"]'::jsonb)
     or not (identity_document -> 'roles' @> '["seller"]'::jsonb) then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;
  if p_device_id is null or p_idempotency_key is null or jsonb_typeof(p_command) <> 'object'
     or p_command -> 'schemaVersion' is distinct from '1'::jsonb
     or not (p_command ?& array['schemaVersion', 'offlineId', 'heliarQuantity', 'mouraQuantity', 'deviceSavedAt'])
     or exists (
       select 1 from jsonb_object_keys(p_command) as supplied(key)
       where not (supplied.key = any(array[
         'schemaVersion', 'offlineId', 'heliarQuantity', 'mouraQuantity', 'observation', 'deviceSavedAt'
       ]))
     ) then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  begin
    v_offline_id := (p_command ->> 'offlineId')::uuid;
  exception when invalid_text_representation then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end;

  -- Match private.sync_event's lock order. Direct PUT and outbox replay may race for
  -- the same intention; taking aggregate first here would invert that order and deadlock.
  perform pg_advisory_xact_lock(hashtextextended(
    v_actor_id::text || ':' || p_device_id::text || ':visit.stock.saved.v1:' || p_idempotency_key::text,
    0
  ));
  perform pg_advisory_xact_lock(hashtextextended(
    v_actor_id::text || ':' || p_device_id::text || ':visit:' || v_offline_id::text,
    1
  ));

  select * into previous_event from private.sync_events stored
  where stored.actor_id = v_actor_id and stored.device_id = p_device_id
    and stored.operation = 'visit.stock.saved.v1' and stored.idempotency_key = p_idempotency_key;
  if found then
    v_event_id := previous_event.event_id;
    v_sequence := previous_event.sequence;
  else
    v_event_id := p_idempotency_key;
    select coalesce(max(stored.sequence), 0) + 1 into v_sequence
    from private.sync_events stored
    where stored.actor_id = v_actor_id and stored.device_id = p_device_id
      and stored.aggregate_type = 'visit' and stored.aggregate_id = v_offline_id;
  end if;

  sync_result := private.sync_event(p_device_id, jsonb_build_object(
    'eventId', v_event_id,
    'idempotencyKey', p_idempotency_key,
    'operation', 'visit.stock.saved.v1',
    'schemaVersion', 1,
    'sequence', v_sequence,
    'aggregateType', 'visit',
    'aggregateId', v_offline_id,
    'occurredAt', p_command ->> 'deviceSavedAt',
    'payload', p_command - 'schemaVersion'
  ));
  return private.get_visit_stock_result((sync_result ->> 'canonicalId')::uuid);
end
$function$;

reset role;
revoke create on schema private from cirne_sync_executor;
do $sync_ownership$
begin
  execute pg_catalog.format('revoke cirne_sync_executor from %I granted by current_user', current_user);
end
$sync_ownership$;

-- GRANT/REVOKE must run as the function owner: the migration operator is not
-- a superuser and its membership has NOINHERIT semantics.
do $visit_ownership$
begin
  execute pg_catalog.format('grant cirne_visit_executor to %I with set true granted by current_user', current_user);
end
$visit_ownership$;
set local role cirne_visit_executor;
revoke all on function private.get_visit_stock_result(uuid),
  private.apply_visit_stock_saved(uuid, jsonb) from public, anon, authenticated;
grant execute on function private.get_visit_stock_result(uuid),
  private.apply_visit_stock_saved(uuid, jsonb) to cirne_sync_executor;
reset role;
do $visit_ownership$
begin
  execute pg_catalog.format('revoke cirne_visit_executor from %I granted by current_user', current_user);
end
$visit_ownership$;

commit;
