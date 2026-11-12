begin;
revoke execute on function api.create_administration_user(uuid,jsonb,text),
  api.record_administration_password_reset(uuid,jsonb,text) from authenticated;
drop function api.record_administration_password_reset(uuid,jsonb,text);
drop function api.create_administration_user(uuid,jsonb,text);
revoke insert on api.user_profiles from cirne_administration_executor;
commit;
