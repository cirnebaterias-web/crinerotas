begin;
revoke execute on function api.create_administration_user(uuid,jsonb,text),
  api.record_administration_password_reset(uuid,jsonb,text),
  api.complete_administration_password_reset(uuid,uuid,text) from authenticated;
drop function api.complete_administration_password_reset(uuid,uuid,text);
drop function api.record_administration_password_reset(uuid,jsonb,text);
drop function api.create_administration_user(uuid,jsonb,text);
revoke insert on api.user_profiles from cirne_administration_executor;
revoke update on private.administration_commands from cirne_administration_executor;
commit;
