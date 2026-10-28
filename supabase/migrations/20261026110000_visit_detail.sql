begin;

create role cirne_visit_detail_executor
  nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;

grant usage on schema api, private, extensions, storage to cirne_visit_detail_executor;
do $identity_ownership$
begin
  execute pg_catalog.format('grant cirne_identity_executor to %I with set true granted by current_user', current_user);
end
$identity_ownership$;
set local role cirne_identity_executor;
grant execute on function private.resolve_current_identity() to cirne_visit_detail_executor;
reset role;
do $identity_ownership$
begin
  execute pg_catalog.format('revoke cirne_identity_executor from %I granted by current_user', current_user);
end
$identity_ownership$;
do $visit_ownership$
begin
  execute pg_catalog.format('grant cirne_visit_executor to %I with set true granted by current_user', current_user);
end
$visit_ownership$;
set local role cirne_visit_executor;
grant select on table api.visits, api.stock_snapshots, api.competitor_price_reports,
  api.competitor_prices, api.parameter_values to cirne_visit_detail_executor;
create policy visits_detail_executor_read on api.visits
  for select to cirne_visit_detail_executor using (true);
create policy stock_detail_executor_read on api.stock_snapshots
  for select to cirne_visit_detail_executor using (true);
create policy price_reports_detail_executor_read on api.competitor_price_reports
  for select to cirne_visit_detail_executor using (true);
create policy prices_detail_executor_read on api.competitor_prices
  for select to cirne_visit_detail_executor using (true);
create policy parameter_values_detail_executor_read on api.parameter_values
  for select to cirne_visit_detail_executor using (true);
reset role;
do $visit_ownership$
begin
  execute pg_catalog.format('revoke cirne_visit_executor from %I granted by current_user', current_user);
end
$visit_ownership$;

grant select on table api.visit_commercial_action_reports, api.visit_own_action_acknowledgements,
  api.visit_competitor_commercial_actions to cirne_visit_detail_executor;
create policy action_reports_detail_executor_read on api.visit_commercial_action_reports
  for select to cirne_visit_detail_executor using (true);
create policy own_actions_detail_executor_read on api.visit_own_action_acknowledgements
  for select to cirne_visit_detail_executor using (true);
create policy competitor_actions_detail_executor_read on api.visit_competitor_commercial_actions
  for select to cirne_visit_detail_executor using (true);

grant select on table api.scrap_reports, api.scrap_collections, api.pickup_schedules,
  api.scrap_attachments to cirne_visit_detail_executor;
create policy scrap_reports_detail_executor_read on api.scrap_reports
  for select to cirne_visit_detail_executor using (true);
create policy scrap_collections_detail_executor_read on api.scrap_collections
  for select to cirne_visit_detail_executor using (true);
create policy pickup_schedules_detail_executor_read on api.pickup_schedules
  for select to cirne_visit_detail_executor using (true);
create policy scrap_attachments_detail_executor_read on api.scrap_attachments
  for select to cirne_visit_detail_executor using (true);

do $visit_ownership$
begin
  execute pg_catalog.format('grant cirne_visit_executor to %I with set true granted by current_user', current_user);
end
$visit_ownership$;
set local role cirne_visit_executor;
grant select on table api.visit_attachments, api.location_events to cirne_visit_detail_executor;
create policy visit_attachments_detail_executor_read on api.visit_attachments
  for select to cirne_visit_detail_executor using (true);
create policy location_events_detail_executor_read on api.location_events
  for select to cirne_visit_detail_executor using (true);
reset role;
do $visit_ownership$
begin
  execute pg_catalog.format('revoke cirne_visit_executor from %I granted by current_user', current_user);
end
$visit_ownership$;

do $sync_ownership$
begin
  execute pg_catalog.format('grant cirne_sync_executor to %I with set true granted by current_user', current_user);
end
$sync_ownership$;
set local role cirne_sync_executor;
grant select on table private.sync_events to cirne_visit_detail_executor;
create policy sync_events_detail_executor_read on private.sync_events
  for select to cirne_visit_detail_executor using (true);
reset role;
do $sync_ownership$
begin
  execute pg_catalog.format('revoke cirne_sync_executor from %I granted by current_user', current_user);
end
$sync_ownership$;

do $management_ownership$
begin
  execute pg_catalog.format('grant cirne_management_executor to %I with set true granted by current_user', current_user);
end
$management_ownership$;
set local role cirne_management_executor;
grant select on table private.sync_failure_observations to cirne_visit_detail_executor;
create policy sync_failures_detail_executor_read on private.sync_failure_observations
  for select to cirne_visit_detail_executor using (true);
reset role;
do $management_ownership$
begin
  execute pg_catalog.format('revoke cirne_management_executor from %I granted by current_user', current_user);
end
$management_ownership$;

do $sync_ownership$
begin
  execute pg_catalog.format('grant cirne_sync_executor to %I with set true granted by current_user', current_user);
end
$sync_ownership$;
set local role cirne_sync_executor;
grant select, insert on table private.audit_events to cirne_visit_detail_executor;
create policy audit_events_detail_executor_read on private.audit_events
  for select to cirne_visit_detail_executor using (true);
create policy audit_events_detail_executor_insert on private.audit_events
  for insert to cirne_visit_detail_executor with check (true);
reset role;
do $sync_ownership$
begin
  execute pg_catalog.format('revoke cirne_sync_executor from %I granted by current_user', current_user);
end
$sync_ownership$;
grant select on table storage.objects to cirne_visit_detail_executor;
create policy storage_visit_detail_executor_read on storage.objects
  for select to cirne_visit_detail_executor using (bucket_id in ('visit-evidence', 'scrap-evidence'));

create view api.visit_details_v with (security_invoker = true) as
select
  visit.id as visit_id,
  visit.seller_id,
  visit.route_version_id,
  visit.route_version_stop_id,
  visit.client_id,
  visit.parameter_set_id,
  visit.context_snapshot,
  visit.status,
  visit.device_started_at,
  visit.server_started_at,
  visit.device_completed_at,
  visit.server_completed_at,
  visit.updated_at
from api.visits visit;

revoke all on table api.visit_details_v from public, anon, authenticated;
grant select on table api.visit_details_v to cirne_visit_detail_executor;

create function private.visit_detail_identity(p_visit_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $function$
declare
  identity_document jsonb := private.resolve_current_identity();
begin
  if p_visit_id is null
     or identity_document is null
     or not (identity_document -> 'roles' @> '["manager"]'::jsonb)
     or not (identity_document -> 'capabilities' @> '["route.read_scoped"]'::jsonb)
     or not exists (
       select 1 from api.visits visit
       where visit.id = p_visit_id
         and exists (
           select 1 from jsonb_array_elements_text(identity_document -> 'scopeIds') scope(id)
           where scope.id::uuid = visit.seller_id
         )
     ) then
    raise exception using errcode = 'P0001', message = 'NOT_FOUND';
  end if;
  return identity_document;
end
$function$;

create function private.can_manager_download_visit_evidence(p_bucket text, p_name text)
returns boolean language plpgsql stable security definer set search_path = '' as $function$
declare
  identity_document jsonb := private.resolve_current_identity();
  scoped_visit_id uuid;
begin
  if identity_document is null
     or not (identity_document -> 'roles' @> '["manager"]'::jsonb)
     or not (identity_document -> 'capabilities' @> '["route.read_scoped"]'::jsonb)
     or not (identity_document -> 'capabilities' @> '["visit.evidence.read_scoped"]'::jsonb) then
    return false;
  end if;
  if p_bucket = 'visit-evidence' then
    select attachment.visit_id into scoped_visit_id from api.visit_attachments attachment
    where attachment.storage_path = p_name and attachment.status = 'verified';
  elsif p_bucket = 'scrap-evidence' then
    select report.visit_id into scoped_visit_id
    from api.scrap_attachments attachment
    join api.scrap_collections collection on collection.id = attachment.collection_id
    join api.scrap_reports report on report.id = collection.report_id
    where attachment.storage_path = p_name and attachment.status = 'verified';
  end if;
  return scoped_visit_id is not null and exists (
    select 1 from api.visits visit where visit.id = scoped_visit_id
      and exists (select 1 from jsonb_array_elements_text(identity_document -> 'scopeIds') scope(id)
        where scope.id::uuid = visit.seller_id)
  );
end
$function$;

create policy visit_evidence_manager_sensitive_read on storage.objects
  for select to authenticated
  using (bucket_id = 'visit-evidence' and private.can_manager_download_visit_evidence(bucket_id, name));
create policy scrap_evidence_manager_sensitive_read on storage.objects
  for select to authenticated
  using (bucket_id = 'scrap-evidence' and private.can_manager_download_visit_evidence(bucket_id, name));

create function private.get_visit_detail(p_visit_id uuid, p_request_id uuid, p_origin text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $function$
declare
  identity_document jsonb := private.visit_detail_identity(p_visit_id);
  visit_row api.visits%rowtype;
  location_allowed boolean := identity_document -> 'capabilities' @> '["visit.location.read_scoped"]'::jsonb;
  evidence_allowed boolean := identity_document -> 'capabilities' @> '["visit.evidence.read_scoped"]'::jsonb;
  location_document jsonb := jsonb_build_object('state', 'withheld');
  evidence_document jsonb := jsonb_build_object('state', 'withheld');
  result_document jsonb;
begin
  if p_request_id is null or p_origin not in ('web', 'cli') then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  select * into strict visit_row from api.visits where id = p_visit_id;

  if location_allowed then
    select coalesce((select jsonb_build_object(
      'state', 'available',
      'latitude', extensions.st_y(event.position::extensions.geometry)::text,
      'longitude', extensions.st_x(event.position::extensions.geometry)::text,
      'accuracyM', event.accuracy_m::text,
      'distanceM', event.distance_m::text,
      'capturedAt', event.device_captured_at
    ) from api.location_events event
      where event.visit_id = visit_row.id and event.position is not null
      order by event.device_captured_at desc, event.id desc limit 1),
      jsonb_build_object('state', 'unknown_to_server')) into location_document;
    insert into private.audit_events (
      actor_id, target_type, target_id, action, before_data, after_data, origin, request_id, occurred_at
    ) values (
      (identity_document ->> 'id')::uuid, 'visit', visit_row.id, 'visit.location.read.v1',
      null, jsonb_build_object('authorized', true), p_origin, p_request_id, clock_timestamp()
    );
  end if;

  if evidence_allowed then
    select jsonb_build_object('state', 'available', 'items', coalesce(jsonb_agg(item.document order by item.captured_at, item.id), '[]'::jsonb))
    into evidence_document from (
      select attachment.id, attachment.captured_at, jsonb_build_object(
        'id', attachment.id, 'purpose', attachment.purpose, 'contentType', attachment.content_type,
        'byteSize', attachment.byte_size, 'capturedAt', attachment.captured_at,
        'verifiedAt', attachment.verified_at,
        'downloadUrlPath', '/api/v1/attachments/' || attachment.id || '/download-url'
      ) as document
      from api.visit_attachments attachment
      where attachment.visit_id = visit_row.id and attachment.status = 'verified'
      union all
      select attachment.id, attachment.captured_at, jsonb_build_object(
        'id', attachment.id, 'purpose', 'scrap_receipt', 'contentType', attachment.content_type,
        'byteSize', attachment.byte_size, 'capturedAt', attachment.captured_at,
        'verifiedAt', attachment.verified_at,
        'downloadUrlPath', '/api/v1/attachments/' || attachment.id || '/download-url'
      ) as document
      from api.scrap_attachments attachment
      join api.scrap_collections collection on collection.id = attachment.collection_id
      join api.scrap_reports report on report.id = collection.report_id
      where report.visit_id = visit_row.id and attachment.status = 'verified'
      order by captured_at, id limit 20
    ) item;
  end if;

  select jsonb_build_object(
    'schemaVersion', 1,
    'visitId', visit_row.id,
    'context', jsonb_build_object(
      'serviceDate', visit_row.context_snapshot #>> '{route,serviceDate}',
      'route', jsonb_build_object(
        'id', (visit_row.context_snapshot #>> '{route,id}')::uuid,
        'versionId', visit_row.route_version_id,
        'versionNumber', (visit_row.context_snapshot #>> '{route,versionNumber}')::integer
      ),
      'stop', jsonb_build_object(
        'id', visit_row.route_version_stop_id,
        'plannedOrder', (visit_row.context_snapshot #>> '{route,plannedOrder}')::integer,
        'priority', (visit_row.context_snapshot #>> '{route,priority}')::integer
      ),
      'client', jsonb_build_object(
        'id', visit_row.client_id,
        'externalReference', visit_row.context_snapshot #>> '{client,externalReference}',
        'name', visit_row.context_snapshot #>> '{client,name}',
        'address', visit_row.context_snapshot #>> '{client,address}'
      ),
      'seller', jsonb_build_object(
        'id', visit_row.seller_id,
        'displayName', visit_row.context_snapshot #>> '{seller,displayName}'
      ),
      'parameterSet', jsonb_build_object(
        'id', visit_row.parameter_set_id,
        'version', (visit_row.context_snapshot #>> '{parameters,version}')::integer
      )
    ),
    'status', visit_row.status,
    'deviceStartedAt', visit_row.device_started_at,
    'serverStartedAt', visit_row.server_started_at,
    'deviceCompletedAt', visit_row.device_completed_at,
    'serverCompletedAt', visit_row.server_completed_at,
    'lastKnownUpdateAt', greatest(
      visit_row.updated_at,
      coalesce((select max(event.updated_at) from private.sync_events event
        where event.canonical_result ->> 'canonicalId' = visit_row.id::text), visit_row.updated_at)
    ),
    'serverVisibilityNote',
      'Somente dados recebidos e confirmados pelo servidor estão presentes; conteúdo ainda apenas no aparelho não é conhecido.',
    'sections', jsonb_build_object(
      'stock', coalesce((select jsonb_build_object(
        'state', 'available', 'recordedAt', stock.server_saved_at,
        'heliarQuantity', stock.heliar_quantity, 'mouraQuantity', stock.moura_quantity,
        'ownLines', coalesce(stock.details -> 'ownLines', '[]'::jsonb),
        'competitorLines', coalesce(stock.details -> 'competitorLines', '[]'::jsonb),
        'observation', stock.observation
      ) from api.stock_snapshots stock where stock.visit_id = visit_row.id), jsonb_build_object('state', 'absent')),
      'competitorPrices', coalesce((select jsonb_build_object(
        'state', 'available', 'recordedAt', report.server_saved_at,
        'availability', report.availability,
        'unavailableReason', case when reason.id is null then null else jsonb_build_object('id', reason.id, 'label', reason.label) end,
        'quotations', coalesce((select jsonb_agg(jsonb_build_object(
          'id', price.id,
          'competitor', jsonb_build_object('id', price.competitor_id, 'label', competitor.label),
          'productCode', price.product_code,
          'modelOrAmperage', price.model_or_amperage,
          'technology', jsonb_build_object('id', price.technology_id, 'label', technology.label),
          'priceBrl', price.price_brl::text,
          'condition', jsonb_build_object('id', price.condition_id, 'label', condition.label),
          'observation', price.observation
        ) order by price.ordinal) from api.competitor_prices price
          join api.parameter_values competitor on competitor.id = price.competitor_id
          join api.parameter_values technology on technology.id = price.technology_id
          join api.parameter_values condition on condition.id = price.condition_id
          where price.report_id = report.id), '[]'::jsonb)
      ) from api.competitor_price_reports report
        left join api.parameter_values reason on reason.id = report.unavailable_reason_id
        where report.visit_id = visit_row.id), jsonb_build_object('state', 'absent')),
      'commercialActions', coalesce((select jsonb_build_object(
        'state', 'available', 'recordedAt', report.server_saved_at,
        'ownAcknowledgements', coalesce((select jsonb_agg(jsonb_build_object(
          'actionId', acknowledgement.commercial_action_id, 'title', acknowledgement.title_snapshot,
          'presented', acknowledgement.presented
        ) order by acknowledgement.ordinal) from api.visit_own_action_acknowledgements acknowledgement
          where acknowledgement.report_id = report.id), '[]'::jsonb),
        'competitor', jsonb_build_object(
          'availability', report.competitor_availability,
          'actions', coalesce((select jsonb_agg(jsonb_build_object(
            'id', action.id, 'competitorId', action.competitor_id,
            'actionType', case when action.action_type = 'other' then action.other_type else action.action_type end,
            'description', action.description, 'validFrom', action.valid_from, 'validUntil', action.valid_until
          ) order by action.ordinal) from api.visit_competitor_commercial_actions action
            where action.report_id = report.id), '[]'::jsonb)
        )
      ) from api.visit_commercial_action_reports report where report.visit_id = visit_row.id), jsonb_build_object('state', 'absent')),
      'scrap', coalesce((select jsonb_build_object(
        'state', 'available', 'recordedAt', report.device_saved_at,
        'availability', report.availability,
        'collectedWeightKg', collection.actual_weight_kg::text,
        'scheduledWeightKg', schedule.estimated_weight_kg::text,
        'collection', case when collection.id is null then null else jsonb_build_object(
          'id', collection.id, 'collectedAt', collection.collected_at,
          'receiptNumber', collection.receipt_number, 'destinationName', collection.destination_name_snapshot
        ) end,
        'schedule', case when schedule.id is null then null else jsonb_build_object(
          'id', schedule.id, 'desiredDate', schedule.desired_date, 'period', schedule.period,
          'status', schedule.status, 'observation', schedule.observation
        ) end
      ) from api.scrap_reports report
        left join api.scrap_collections collection on collection.report_id = report.id
        left join api.pickup_schedules schedule on schedule.report_id = report.id
        where report.visit_id = visit_row.id), jsonb_build_object('state', 'absent')),
      'result', case when visit_row.status = 'completed' then jsonb_build_object(
        'state', 'available', 'outcome', 'completed',
        'deviceCompletedAt', visit_row.device_completed_at,
        'serverCompletedAt', visit_row.server_completed_at
      ) else jsonb_build_object('state', 'absent') end
    ),
    'synchronization', coalesce((select jsonb_build_object(
      'status', coalesce(failure.status, event.status),
      'occurredAt', event.occurred_at, 'receivedAt', event.updated_at,
      'confirmedAt', event.confirmed_at,
      'attemptCount', greatest(event.attempt_count, coalesce(failure.attempt_count, 1)),
      'lastErrorCode', failure.error_code
    ) from private.sync_events event
      left join private.sync_failure_observations failure
        on failure.actor_id = event.actor_id and failure.device_id = event.device_id and failure.event_id = event.event_id
      where event.canonical_result ->> 'canonicalId' = visit_row.id::text
      order by event.updated_at desc, event.id desc limit 1), jsonb_build_object(
        'status', 'confirmed', 'occurredAt', visit_row.device_started_at,
        'receivedAt', visit_row.server_started_at, 'confirmedAt', visit_row.server_started_at,
        'attemptCount', 1, 'lastErrorCode', null
      )),
    'exceptions', coalesce((select jsonb_agg(jsonb_build_object(
      'kind', bounded_issue.kind,
      'message', case bounded_issue.kind
        when 'camera_unavailable' then 'A câmera não estava disponível; a visita continuou com justificativa.'
        when 'gps_unavailable' then 'A localização não estava disponível; a visita continuou com justificativa.'
        when 'gps_low_accuracy' then 'A precisão da localização estava reduzida no momento do registro.'
        when 'outside_radius' then 'O registro ocorreu fora do raio esperado e foi justificado.'
        else 'A localização cadastrada do cliente não estava disponível.' end,
      'capturedAt', bounded_issue.device_captured_at
    ) order by bounded_issue.device_captured_at, bounded_issue.kind) from (
      select event.device_captured_at, issue.kind
      from api.location_events event
      cross join lateral unnest(event.issues) issue(kind)
      where event.visit_id = visit_row.id
      order by event.device_captured_at, issue.kind
      limit 10
    ) bounded_issue), '[]'::jsonb),
    'location', location_document,
    'evidence', evidence_document,
    'timeline', coalesce((select jsonb_agg(jsonb_build_object(
      'action', audit.action,
      'origin', case when audit.origin in ('web','pwa','cli','system') then audit.origin else 'system' end,
      'occurredAt', audit.occurred_at
    ) order by audit.occurred_at, audit.id) from (
      select event.* from private.audit_events event
      where event.target_type = 'visit' and event.target_id = visit_row.id
      order by event.occurred_at desc, event.id desc limit 100
    ) audit), '[]'::jsonb)
  ) into result_document;
  return result_document;
end
$function$;

create function api.get_visit_detail(p_visit_id uuid, p_request_id uuid, p_origin text default 'web')
returns jsonb language sql volatile security definer set search_path = '' as $function$
  select private.get_visit_detail(p_visit_id, p_request_id, p_origin);
$function$;

create function private.authorize_visit_attachment_download(
  p_attachment_id uuid, p_request_id uuid, p_origin text
)
returns jsonb language plpgsql volatile security definer set search_path = '' as $function$
declare
  identity_document jsonb := private.resolve_current_identity();
  visit_id uuid;
  evidence_kind text;
  seller_id uuid;
  parent_id uuid;
  content_type text;
  bucket text;
  object_path text;
begin
  if identity_document is null
     or not (identity_document -> 'roles' @> '["manager"]'::jsonb)
     or not (identity_document -> 'capabilities' @> '["route.read_scoped"]'::jsonb)
     or not (identity_document -> 'capabilities' @> '["visit.evidence.read_scoped"]'::jsonb)
     or p_attachment_id is null or p_request_id is null or p_origin not in ('web', 'cli') then
    raise exception using errcode = 'P0001', message = 'NOT_FOUND';
  end if;

  select attachment.visit_id, 'visit', attachment.seller_id, attachment.visit_id,
    attachment.content_type, 'visit-evidence', attachment.storage_path
  into visit_id, evidence_kind, seller_id, parent_id, content_type, bucket, object_path
  from api.visit_attachments attachment
  where attachment.id = p_attachment_id and attachment.status = 'verified';
  if not found then
    select report.visit_id, 'scrap', attachment.seller_id, attachment.collection_id,
      attachment.content_type, 'scrap-evidence', attachment.storage_path
    into visit_id, evidence_kind, seller_id, parent_id, content_type, bucket, object_path
    from api.scrap_attachments attachment
    join api.scrap_collections collection on collection.id = attachment.collection_id
    join api.scrap_reports report on report.id = collection.report_id
    where attachment.id = p_attachment_id and attachment.status = 'verified';
  end if;
  perform private.visit_detail_identity(visit_id);
  if not exists (select 1 from storage.objects object where object.bucket_id = bucket and object.name = object_path) then
    raise exception using errcode = 'P0001', message = 'NOT_FOUND';
  end if;
  insert into private.audit_events (
    actor_id, target_type, target_id, action, before_data, after_data, origin, request_id, occurred_at
  ) values (
    (identity_document ->> 'id')::uuid, 'visit_attachment', p_attachment_id,
    'visit.evidence.download_url.issued.v1', null,
    jsonb_build_object('visitId', visit_id, 'expiresInSeconds', 60), p_origin, p_request_id, clock_timestamp()
  );
  -- The caller-facing RPC returns only canonical metadata. The BFF reconstructs the
  -- deterministic object location server-side and lets caller-scoped Storage RLS
  -- authorize the actual signing request; the Data API never exposes the path.
  return jsonb_build_object(
    'attachmentId', p_attachment_id,
    'evidenceKind', evidence_kind,
    'sellerId', seller_id,
    'parentId', parent_id,
    'contentType', content_type,
    'expiresInSeconds', 60
  );
end
$function$;

create function api.authorize_visit_attachment_download(
  p_attachment_id uuid, p_request_id uuid, p_origin text default 'web'
)
returns jsonb language sql volatile security definer set search_path = '' as $function$
  select private.authorize_visit_attachment_download(p_attachment_id, p_request_id, p_origin);
$function$;

do $management_function_ownership$
begin
  execute pg_catalog.format('grant cirne_management_executor to %I with set true granted by current_user', current_user);
end
$management_function_ownership$;
grant create on schema api to cirne_management_executor;
set local role cirne_management_executor;
create or replace function api.get_management_day(p_service_date date, p_operational_time_zone text)
returns jsonb language plpgsql stable security definer set search_path = '' as $function$
declare
  document jsonb := private.get_management_day(p_service_date, p_operational_time_zone);
  identity_document jsonb := private.management_identity();
  enriched_routes jsonb;
begin
  select coalesce(jsonb_agg(
    route_document || jsonb_build_object('visits', coalesce((
      select jsonb_agg(jsonb_build_object(
        'visitId', visit.id,
        'routeVersionStopId', visit.route_version_stop_id,
        'client', jsonb_build_object('id', visit.client_id, 'name', visit.context_snapshot #>> '{client,name}'),
        'status', visit.status,
        'deviceStartedAt', visit.device_started_at,
        'serverStartedAt', visit.server_started_at,
        'lastKnownUpdateAt', visit.updated_at
      ) order by visit.server_started_at, visit.id)
      from (
        select candidate.* from api.visits candidate
        where candidate.route_version_id = (route_document ->> 'routeVersionId')::uuid
          and exists (
            select 1 from jsonb_array_elements_text(identity_document -> 'scopeIds') scope(id)
            where scope.id::uuid = candidate.seller_id
          )
        order by candidate.server_started_at, candidate.id
        limit 50
      ) visit
    ), '[]'::jsonb))
    order by route_document -> 'seller' ->> 'displayName', route_document ->> 'routeId'
  ), '[]'::jsonb)
  into enriched_routes
  from jsonb_array_elements(document -> 'routes') route_document;
  return jsonb_set(document, '{routes}', enriched_routes);
end
$function$;
reset role;
revoke create on schema api from cirne_management_executor;
do $management_function_ownership$
begin
  execute pg_catalog.format('revoke cirne_management_executor from %I granted by current_user', current_user);
end
$management_function_ownership$;

do $visit_management_policy_ownership$
begin
  execute pg_catalog.format('grant cirne_visit_executor to %I with set true granted by current_user', current_user);
end
$visit_management_policy_ownership$;
set local role cirne_visit_executor;
grant select on table api.visits to cirne_management_executor;
create policy visits_management_executor_read on api.visits
  for select to cirne_management_executor using (true);
reset role;
do $visit_management_policy_ownership$
begin
  execute pg_catalog.format('revoke cirne_visit_executor from %I granted by current_user', current_user);
end
$visit_management_policy_ownership$;

do $detail_ownership$
begin
  execute pg_catalog.format('grant cirne_visit_detail_executor to %I with set true granted by current_user', current_user);
end
$detail_ownership$;
grant create on schema api, private to cirne_visit_detail_executor;
alter view api.visit_details_v owner to cirne_visit_detail_executor;
alter function private.visit_detail_identity(uuid) owner to cirne_visit_detail_executor;
alter function private.can_manager_download_visit_evidence(text, text) owner to cirne_visit_detail_executor;
alter function private.get_visit_detail(uuid, uuid, text) owner to cirne_visit_detail_executor;
alter function api.get_visit_detail(uuid, uuid, text) owner to cirne_visit_detail_executor;
alter function private.authorize_visit_attachment_download(uuid, uuid, text) owner to cirne_visit_detail_executor;
alter function api.authorize_visit_attachment_download(uuid, uuid, text) owner to cirne_visit_detail_executor;

revoke all on function private.visit_detail_identity(uuid),
  private.get_visit_detail(uuid, uuid, text),
  private.authorize_visit_attachment_download(uuid, uuid, text)
from public, anon, authenticated;
revoke all on function private.can_manager_download_visit_evidence(text, text)
from public, anon;
grant execute on function private.can_manager_download_visit_evidence(text, text)
to authenticated;
revoke all on function api.get_visit_detail(uuid, uuid, text),
  api.authorize_visit_attachment_download(uuid, uuid, text)
from public, anon;
grant execute on function api.get_visit_detail(uuid, uuid, text),
  api.authorize_visit_attachment_download(uuid, uuid, text)
to authenticated;

comment on view api.visit_details_v is
  'Projeção mínima de fatos de visita; acesso externo somente pelas RPCs autorizadas.';
comment on function api.get_visit_detail(uuid, uuid, text) is
  'Detalhe gerencial com escopo e redaction sensível por capacidades não atribuídas por padrão.';
comment on function api.authorize_visit_attachment_download(uuid, uuid, text) is
  'Autoriza evidência no escopo do Gestor e retorna somente metadados canônicos; o caminho é resolvido no BFF caller-scoped.';

revoke create on schema api, private from cirne_visit_detail_executor;
do $detail_ownership$
begin
  execute pg_catalog.format('revoke cirne_visit_detail_executor from %I granted by current_user', current_user);
end
$detail_ownership$;

commit;
