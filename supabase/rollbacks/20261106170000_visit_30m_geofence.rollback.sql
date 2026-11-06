begin;
drop function if exists api.save_visit_checkin_evidence(uuid,uuid,jsonb);
drop function if exists api.complete_visit(uuid,uuid,jsonb);
alter function api.save_visit_checkin_evidence_without_geofence(uuid,uuid,jsonb)
  rename to save_visit_checkin_evidence;
alter function api.complete_visit_without_geofence(uuid,uuid,jsonb)
  rename to complete_visit;
drop table if exists api.client_observed_locations;
grant execute on function api.save_visit_checkin_evidence(uuid,uuid,jsonb),
  api.complete_visit(uuid,uuid,jsonb) to authenticated;
commit;
