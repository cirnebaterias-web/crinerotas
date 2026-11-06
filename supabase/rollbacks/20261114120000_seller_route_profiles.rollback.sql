-- Forward-only safety rollback: block writes while preserving profile and audit history.
begin;
revoke execute on function api.update_seller_route_profile(uuid,jsonb,text) from authenticated;
comment on function api.update_seller_route_profile(uuid,jsonb,text) is
  'ROLLBACK: writes disabled; retained for profile and audit recovery.';
commit;
