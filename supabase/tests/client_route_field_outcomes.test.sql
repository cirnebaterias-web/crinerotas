begin;
select no_plan();

select has_table('api','client_classifications','classification catalog exists');
select has_table('api','route_stop_attempts','non-visit aggregate exists');
select has_table('api','route_stop_attempt_attachments','non-visit evidence exists');
select has_column('api','clients','classification_id','client has optional classification');
select has_column('api','clients','operating_status','operational status is separate');
select has_column('api','route_version_stops','source','route stop origin is explicit');
select is((select count(*)::integer from api.client_classifications where published),13,'exactly 13 classifications are published');
select is((select string_agg(code,',' order by display_order) from api.client_classifications),
  'acessorios_automotivos,autoeletricas,autopecas,casa_de_baterias,centro_automotivo,concessionarias,frotista,generalista,loja_lubrificantes_pneus,oficina_mecanica,outros,delivery,consumidor',
  'classification codes and publication order are stable');
select is((select count(*)::integer from api.route_stop_attempt_reasons where published),9,'exactly nine non-visit reasons are published');

select has_function('api','list_client_classifications',array[]::text[],'catalog read RPC exists');
select has_function('api','classify_client',array['uuid','uuid','jsonb'],'classification command exists');
select has_function('api','list_management_client_field_profiles',array['uuid[]'],'management classification/status read exists');
select has_function('api','close_client_operations',array['uuid','uuid','jsonb'],'operational closure command exists');
select has_function('api','extend_seller_route',array['uuid','uuid','jsonb'],'route extension command exists');
select has_function('api','record_route_stop_attempt',array['uuid','uuid','jsonb'],'non-visit command exists');
select has_function('api','list_management_day_route_stop_attempts',array['date'],'management attempt projection exists');
select has_function('api','get_management_route_stop_attempt_attachment',array['uuid'],'authorized management attachment lookup exists');
select ok(not has_function_privilege('anon','api.classify_client(uuid,uuid,jsonb)','EXECUTE'),'anonymous classification is denied');
select ok(not has_function_privilege('anon','api.record_route_stop_attempt(uuid,uuid,jsonb)','EXECUTE'),'anonymous non-visit is denied');
select ok(not has_function_privilege('authenticated','api.verify_route_stop_attempt_attachment(uuid,uuid,uuid,uuid,text)','EXECUTE'),'browser cannot invoke trusted evidence verification');
select ok(has_function_privilege('service_role','api.verify_route_stop_attempt_attachment(uuid,uuid,uuid,uuid,text)','EXECUTE'),'trusted verifier can confirm evidence');
select ok(not has_function_privilege('anon','api.list_management_day_route_stop_attempts(date)','EXECUTE'),'anonymous management attempt projection is denied');
select ok(has_function_privilege('authenticated','api.list_management_day_route_stop_attempts(date)','EXECUTE'),'authenticated management attempt projection is executable and internally scoped');
select ok(not has_function_privilege('anon','api.get_management_route_stop_attempt_attachment(uuid)','EXECUTE'),'anonymous management photo lookup is denied');
select ok(has_function_privilege('authenticated','api.get_management_route_stop_attempt_attachment(uuid)','EXECUTE'),'authenticated management photo lookup is executable and internally scoped');
select throws_ok($$select api.classify_client('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','{"schemaVersion":1,"clientId":"10000000-0000-4000-8000-000000000003","classificationCode":"autopecas"}'::jsonb)$$,
  'P0001','FORBIDDEN','classification requires an authorized identity before receipt/replay lookup');
select throws_ok($$select api.record_route_stop_attempt('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','{"schemaVersion":1}'::jsonb)$$,
  'P0001','FORBIDDEN','non-visit replay is denied without route ownership');
select ok(not has_table_privilege('authenticated','api.route_stop_attempts','SELECT'),'attempt rows are not exposed directly');
select ok(not has_table_privilege('authenticated','private.field_command_receipts','SELECT'),'idempotency receipts remain private');
select ok((select attnotnull from pg_attribute where attrelid='api.clients'::regclass and attname='operating_status'),
  'operating status is canonical and non-null');
select ok(not (select attnotnull from pg_attribute where attrelid='api.clients'::regclass and attname='classification_id'),
  'existing clients remain unclassified');

select * from finish();
rollback;
