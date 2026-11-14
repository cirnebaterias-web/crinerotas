begin;

do $safety$
begin
  if exists(select 1 from api.clients where classification_id is not null or operating_status<>'active')
     or exists(select 1 from api.route_version_stops where source<>'planned')
     or exists(select 1 from api.route_stop_attempts)
     or exists(select 1 from api.route_stop_attempt_attachments)
     or exists(select 1 from private.field_command_receipts) then
    raise exception 'Rollback refused: field outcome data exists; preserve/export history before schema removal';
  end if;
end
$safety$;

do $ownership$
begin
  execute pg_catalog.format('grant cirne_route_executor to %I with set true granted by current_user',current_user);
end
$ownership$;
drop policy if exists route_stop_attempt_evidence_insert_self on storage.objects;
drop policy if exists route_stop_attempt_evidence_select_self on storage.objects;
do $management_ownership$
begin
  execute pg_catalog.format('grant cirne_management_executor to %I with set true granted by current_user',current_user);
end
$management_ownership$;
grant create on schema api to cirne_management_executor;
set local role cirne_management_executor;
create or replace view api.management_day_v as
select route_row.id as route_id,route_row.service_date,route_row.seller_id,
  version_row.seller_context_snapshot->>'displayName' as seller_display_name,
  version_row.id as route_version_id,version_row.version_number,stop_row.id as route_version_stop_id,
  stop_row.client_id,coalesce(stop_row.client_context_snapshot->>'name',client.name) as client_name,
  execution_row.status,execution_row.non_visit_reason_id,
  greatest(route_row.updated_at,execution_row.updated_at) as last_known_update_at,
  stop_row.planned_order,execution_row.execution_order,stop_row.priority,
  coalesce(reason.label,'Motivo registrado') as non_visit_reason_label
from api.routes route_row
join api.route_versions version_row on version_row.route_id=route_row.id and version_row.status='published' and version_row.superseded_at is null
join api.route_version_stops stop_row on stop_row.route_version_id=version_row.id
join api.route_stop_executions execution_row on execution_row.route_version_stop_id=stop_row.id
join api.clients client on client.id=stop_row.client_id
left join api.parameter_values reason on reason.id=execution_row.non_visit_reason_id
where route_row.status in('published','in_progress','closed');
drop function if exists api.list_management_day_route_stop_attempts(date);
drop function if exists api.get_management_route_stop_attempt_attachment(uuid);
reset role;
revoke create on schema api from cirne_management_executor;
do $management_ownership$
begin
  execute pg_catalog.format('revoke cirne_management_executor from %I granted by current_user',current_user);
end
$management_ownership$;
set local role cirne_route_executor;
drop function if exists api.record_route_stop_attempt(uuid,uuid,jsonb);
drop function if exists api.purge_expired_route_stop_attempt_evidence(integer);
drop function if exists api.list_expired_route_stop_attempt_evidence(integer);
drop function if exists private.can_access_route_stop_attempt_attachment(text);
drop function if exists api.confirm_route_stop_attempt_attachment(uuid,uuid,uuid,text);
drop function if exists api.verify_route_stop_attempt_attachment(uuid,uuid,uuid,uuid,text);
drop function if exists api.get_route_stop_attempt_attachment_for_confirmation(uuid,uuid);
drop function if exists api.reserve_route_stop_attempt_attachment(uuid,uuid,jsonb);
drop function if exists api.extend_seller_route(uuid,uuid,jsonb);
drop function if exists api.close_client_operations(uuid,uuid,jsonb);
drop function if exists api.classify_client(uuid,uuid,jsonb);
drop function if exists api.search_my_route_clients(uuid,text);
drop function if exists api.get_client_field_profile(uuid);
drop function if exists api.list_management_client_field_profiles(uuid[]);
drop function if exists api.list_client_classifications();
drop trigger if exists route_version_stops_guard_closed_client on api.route_version_stops;
drop function if exists private.guard_closed_client_new_stop();
drop function if exists private.field_command_replay(uuid,text,uuid,text);

drop table private.field_command_receipts;
drop table api.route_stop_attempts;
drop table api.route_stop_attempt_attachments;
drop table api.route_stop_attempt_reasons;
drop table if exists api.route_stop_version_lineage;
alter table api.route_version_stops drop column source;
alter table api.clients
  drop constraint clients_operating_status_shape_check,
  drop constraint clients_classification_shape_check,
  drop column operating_closed_at,
  drop column operating_closed_by,
  drop column operating_closed_observation,
  drop column operating_closed_reason,
  drop column operating_status,
  drop column classified_at,
  drop column classified_by,
  drop column classification_id;
drop table api.client_classifications;

reset role;
delete from api.role_permissions where permission_code in (
  'client.classify_self','client.close_self','route.extend_self','route.attempt_self',
  'client.classify_scoped','client.close_scoped'
);
do $ownership$
begin
  execute pg_catalog.format('revoke cirne_route_executor from %I granted by current_user',current_user);
end
$ownership$;

commit;
