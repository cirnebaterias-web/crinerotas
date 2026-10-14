begin;
select no_plan();
do $membership$ begin execute format('grant cirne_visit_executor to %I with set true granted by current_user',current_user); end $membership$;
select has_table('api','scrap_collections','seller collections exist');
select has_table('api','pickup_schedules','future schedule exists independently');
select has_table('api','scrap_receipts','final receipt is a separate fact');
select has_table('api','scrap_attachments','five-year evidence is separate from visit photos');
select has_table('api','pickup_schedule_revisions','schedule revisions preserve originals');
select ok(not has_table_privilege('authenticated','api.scrap_collections','INSERT'),'no direct seller writes');
select ok(not has_function_privilege('anon','api.confirm_scrap_receipt(uuid,uuid,jsonb)','EXECUTE'),'anonymous receipt is denied');
select ok(not has_function_privilege('authenticated','api.confirm_scrap_attachment(uuid,uuid,uuid,text)','EXECUTE'),'caller cannot assert scrap bytes verified');
select ok(not has_function_privilege('authenticated','api.confirm_visit_attachment(uuid,uuid,uuid,text)','EXECUTE'),'caller cannot assert visit bytes verified');
select ok(not has_function_privilege('authenticated','api.verify_scrap_attachment(uuid,uuid,uuid,uuid,text)','EXECUTE'),'trusted scrap verifier is not public');
select ok(not has_function_privilege('authenticated','api.verify_visit_attachment(uuid,uuid,uuid,uuid,text)','EXECUTE'),'trusted visit verifier is not public');
select ok(not(select rolcanlogin or rolbypassrls from pg_roles where rolname='cirne_scrap_executor'),'executor cannot login or bypass RLS');
select is((select count(*)::integer from pg_class where oid in('api.scrap_reports'::regclass,'api.scrap_collections'::regclass,'api.pickup_schedules'::regclass,'api.scrap_receipts'::regclass,'api.scrap_attachments'::regclass,'api.pickup_schedule_revisions'::regclass) and relrowsecurity and relforcerowsecurity),6,'all process tables force RLS');
select id as seller from auth.users where raw_user_meta_data->>'actorKey'='seller_a' \gset
select id as other from auth.users where raw_user_meta_data->>'actorKey'='seller_b' \gset
select id as manager from auth.users where raw_user_meta_data->>'actorKey'='manager_a' \gset
select id as admin from auth.users where raw_user_meta_data->>'actorKey'='administrator' \gset
insert into api.clients(id,name,address,external_reference) values('31000000-0000-4000-8000-000000000010','Sucata TESTE cliente','Endereco original TESTE','SCRAP-TEST-310');
insert into api.clients(id,name,address,external_reference) values('31000000-0000-4000-8000-000000000011','Sucata TESTE fora da carteira','Endereco restrito TESTE','SCRAP-TEST-311');
insert into api.client_seller_scopes(client_id,seller_id,assigned_by)
values('31000000-0000-4000-8000-000000000010',:'seller',:'admin');
set local role authenticated;
select set_config('request.jwt.claim.sub',:'manager',true);
select api.save_scrap_point('{"name":"Ponto TESTE","address":"Endereco ponto TESTE","active":true}') as point \gset
select is((:'point')::jsonb->>'version','1','point created by authorized management');
select api.create_route_draft(jsonb_build_object('schemaVersion',1,'serviceDate','2099-10-06','sellerId',:'seller','stops',jsonb_build_array(jsonb_build_object('clientId','31000000-0000-4000-8000-000000000010','plannedOrder',1,'priority',0)))) as route \gset
select api.publish_route(((:'route')::jsonb->>'routeId')::uuid,1);
reset role;
select id as stop from api.route_version_stops where route_version_id=((:'route')::jsonb->>'routeVersionId')::uuid \gset
set local role authenticated;
select set_config('request.jwt.claim.sub',:'seller',true);
select is(jsonb_array_length(api.search_scrap_clients('',30)),0,'empty client query does not expose entire client base');
select is(jsonb_array_length(api.search_scrap_clients('Sucata TESTE',30)),1,'seller can find active client outside route');
select is(api.search_scrap_clients('Sucata TESTE',30)->0->>'id','31000000-0000-4000-8000-000000000010','standalone search returns only the explicitly assigned portfolio');
select throws_ok($$select api.create_pickup_schedule('31000000-0000-4000-8000-000000000020','31000000-0000-4000-8000-000000000076','{"schemaVersion":1,"offlineId":"31000000-0000-4000-8000-000000000077","clientId":"31000000-0000-4000-8000-000000000011","estimatedWeightKg":"10","desiredDate":"2099-10-10","period":"morning","requestedAt":"2026-10-08T12:00:00Z"}')$$,'P0001','FORBIDDEN','standalone scheduling rejects a client outside the seller portfolio');
select throws_ok($$select api.save_scrap_point('{"name":"Unauthorized","address":"X","active":true}')$$,'P0001','FORBIDDEN','seller cannot create points');
select api.start_visit('31000000-0000-4000-8000-000000000020','31000000-0000-4000-8000-000000000021',jsonb_build_object('schemaVersion',1,'offlineId','31000000-0000-4000-8000-000000000022','routeVersionStopId',:'stop','deviceStartedAt','2099-10-06T12:00:00Z')) as visit \gset
reset role;
insert into api.visit_commercial_action_reports(visit_id,competitor_availability,last_event_id,device_saved_at) values(((:'visit')::jsonb->>'visitId')::uuid,'not_identified','31000000-0000-4000-8000-000000000024',now());
set local role cirne_visit_executor;
select throws_ok(format('update api.visits set status=''completed'',device_completed_at=now(),server_completed_at=now(),completion_payload_hash=repeat(''b'',64) where id=%L',(:'visit')::jsonb->>'visitId'),'P0001','VERSION_CONFLICT','visit cannot complete without scrap response');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub',:'seller',true);
select jsonb_build_object('schemaVersion',1,'eventId','31000000-0000-4000-8000-000000000025','idempotencyKey','31000000-0000-4000-8000-000000000026','operation','visit.scrap.saved.v1','aggregateType','visit','aggregateId','31000000-0000-4000-8000-000000000022','sequence',2,'occurredAt',now(),'payload',jsonb_build_object('schemaVersion',1,'offlineId','31000000-0000-4000-8000-000000000022','deviceSavedAt',now(),'availability','collected','collection',jsonb_build_object('offlineId','31000000-0000-4000-8000-000000000030','actualWeightKg','100','collectedAt',now(),'receiptNumber','TERMO TESTE 001','clientSigned',true,'sellerSigned',true,'twoCopies',true,'destinationType','concentration_point','concentrationPointId',(:'point')::jsonb->>'id','attachmentOfflineIds',jsonb_build_array('31000000-0000-4000-8000-000000000031')))) as command \gset
select api.sync_event('31000000-0000-4000-8000-000000000020',(:'command')::jsonb) as collected \gset
select is(api.sync_event('31000000-0000-4000-8000-000000000020',(:'command')::jsonb),(:'collected')::jsonb,'collection sync replay is idempotent');
select api.list_scrap_operations()->'collections'->0->>'id' as collection \gset
select set_config('request.jwt.claim.sub',:'manager',true);
-- Exercise history before receipt, then deliberately roll back only this subtransaction.
select throws_ok(format('do $test$ declare history jsonb; begin perform api.revise_scrap_collection(%L,''31000000-0000-4000-8000-000000000059'',%L::jsonb); history:=api.list_scrap_collection_revisions(%L); if jsonb_array_length(history)<>1 or (history->0->''before'') ?| array[''receivedWeightKg'',''receivedLocation'',''receivedBy'',''receivedAt''] or (history->0->''after'') ?| array[''receivedWeightKg'',''receivedLocation'',''receivedBy'',''receivedAt''] then raise exception ''Invalid pre-receipt history''; end if; raise exception using errcode=''Z0001'',message=''VALIDATED_AND_ROLLED_BACK''; end $test$',:'collection',jsonb_build_object('schemaVersion',1,'expectedVersion',1,'reason','Termo conferido antes do recebimento','actualWeightKg','100','collectedAt',now(),'receiptNumber','TERMO TESTE 001','destinationType','concentration_point','concentrationPointId',(:'point')::jsonb->>'id')::text,:'collection'),'Z0001','VALIDATED_AND_ROLLED_BACK','pre-receipt history is readable without nullable receipt placeholders');
select set_config('request.jwt.claim.sub',:'seller',true);
select throws_ok(format('select api.confirm_scrap_receipt(%L,''31000000-0000-4000-8000-000000000041'',''{"schemaVersion":1,"expectedVersion":1,"receivedWeightKg":"98","receivedLocation":"Matriz"}'')',:'collection'),'P0001','FORBIDDEN','seller cannot accept final receipt');
select api.list_scrap_operations()#>>'{totals,scheduledKg}' as previous_scheduled \gset
select api.create_pickup_schedule('31000000-0000-4000-8000-000000000020','31000000-0000-4000-8000-000000000042',jsonb_build_object('schemaVersion',1,'offlineId','31000000-0000-4000-8000-000000000043','clientId','31000000-0000-4000-8000-000000000010','estimatedWeightKg','200','desiredDate','2099-10-10','period','morning','requestedAt',now())) as schedule \gset
select is((:'schedule')::jsonb->>'visitId',null,'standalone schedule has no synthetic visit');
select is((:'schedule')::jsonb->>'origin','standalone','standalone origin preserved');
select is((:'schedule')::jsonb->>'status','pending','future pickup remains pending');
select is(api.list_scrap_operations()#>>'{totals,collectedKg}','100','collection total counts only actual kg');
select is(api.list_scrap_operations()#>>'{totals,receivedKg}','0','declaration is not receipt');
select is(((api.list_scrap_operations()#>>'{totals,scheduledKg}')::numeric - (:'previous_scheduled')::numeric)::text,'200','schedule estimated kg is separate');
select jsonb_build_object('schemaVersion',1,'offlineId','31000000-0000-4000-8000-000000000070','clientId','31000000-0000-4000-8000-000000000010','estimatedWeightKg','12','desiredDate','2026-10-07','period','afternoon','requestedAt','2026-10-07T01:30:00Z') as late_command \gset
select api.create_pickup_schedule('31000000-0000-4000-8000-000000000020','31000000-0000-4000-8000-000000000071',(:'late_command')::jsonb) as late_schedule \gset
select is((:'late_schedule')::jsonb->>'status','pending','offline schedule remains pending when synchronized after its desired date');
select is(((:'late_schedule')::jsonb->>'requestedAt')::timestamptz,'2026-10-07T01:30:00Z'::timestamptz,'late schedule preserves the device request timestamp');
select is(api.create_pickup_schedule('31000000-0000-4000-8000-000000000020','31000000-0000-4000-8000-000000000071',(:'late_command')::jsonb),(:'late_schedule')::jsonb,'late schedule replay is idempotent');
select throws_ok(format('select api.create_pickup_schedule(''31000000-0000-4000-8000-000000000020'',''31000000-0000-4000-8000-000000000072'',%L::jsonb)',((:'late_command')::jsonb||jsonb_build_object('offlineId','31000000-0000-4000-8000-000000000073','desiredDate','2026-10-06'))::text),'P0001','VALIDATION_FAILED','desired date cannot be the same Sao Paulo day as requestedAt');
select throws_ok(format('select api.create_pickup_schedule(''31000000-0000-4000-8000-000000000020'',''31000000-0000-4000-8000-000000000074'',%L::jsonb)',((:'late_command')::jsonb||jsonb_build_object('offlineId','31000000-0000-4000-8000-000000000075','requestedAt','infinity'))::text),'P0001','VALIDATION_FAILED','non-finite request time is rejected');
select api.reserve_scrap_attachment('31000000-0000-4000-8000-000000000020','31000000-0000-4000-8000-000000000044',jsonb_build_object('schemaVersion',1,'offlineId','31000000-0000-4000-8000-000000000031','collectionOfflineId','31000000-0000-4000-8000-000000000030','contentType','image/jpeg','byteSize',4,'checksum',repeat('a',64),'capturedAt',now())) as attachment \gset
select is(jsonb_array_length(api.list_scrap_evidence(:'collection')),0,'reserved term is not presented as verified evidence');
select throws_ok($$select api.confirm_scrap_attachment('31000000-0000-4000-8000-000000000020','31000000-0000-4000-8000-000000000045','31000000-0000-4000-8000-000000000031',repeat('a',64))$$,'42501',null,'direct caller RPC cannot bypass byte verification');
reset role;
set local role service_role;
select throws_ok(format('select api.verify_scrap_attachment(%L,''31000000-0000-4000-8000-000000000020'',''31000000-0000-4000-8000-000000000045'',''31000000-0000-4000-8000-000000000031'',repeat(''a'',64))',:'seller'),'P0001','ATTACHMENT_NOT_VERIFIED','trusted verifier also requires a stored object');
reset role;
select is((select retention_until from api.scrap_collections where id=:'collection'),null::timestamptz,'pending custody has no expiry');
set local role cirne_visit_executor;
select throws_ok(format('update api.visits set status=''completed'',device_completed_at=now(),server_completed_at=now(),completion_payload_hash=repeat(''b'',64) where id=%L',(:'visit')::jsonb->>'visitId'),'P0001','ATTACHMENT_NOT_VERIFIED','visit cannot complete without verified term');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub',:'other',true);
select ok(not exists(select 1 from jsonb_array_elements(api.list_scrap_operations()->'collections') c where c->>'id'=:'collection'),'another seller cannot read collection');
select throws_ok(format('select api.list_scrap_evidence(%L)',:'collection'),'P0001','NOT_FOUND','another seller cannot read private term');
reset role;
-- Grant a synthetic actor logistics inside this rolled-back test only.
insert into api.user_role_assignments(user_id,role_id,assigned_by) values(:'other','00000000-0000-4000-8000-000000000004',:'admin');
set local role authenticated;
select set_config('request.jwt.claim.sub',:'other',true);
select throws_ok(format('select api.confirm_scrap_receipt(%L,''31000000-0000-4000-8000-000000000041'',''{"schemaVersion":1,"expectedVersion":1,"receivedWeightKg":"98","receivedLocation":"Matriz","observation":"Diferença pesada"}'')',:'collection'),'P0001','ATTACHMENT_NOT_VERIFIED','logistics cannot accept unverified term');
reset role;
insert into storage.objects(bucket_id,name,metadata) values('scrap-evidence',(:'attachment')::jsonb->>'storagePath','{"size":4,"mimetype":"application/pdf"}');
set local role authenticated;
select set_config('request.jwt.claim.sub',:'seller',true);
select is(jsonb_array_length(api.list_scrap_evidence(:'collection')),0,'uploaded but unverified term is not presented as evidence');
reset role;
set local role service_role;
select throws_ok(format('select api.verify_scrap_attachment(%L,''31000000-0000-4000-8000-000000000020'',''31000000-0000-4000-8000-000000000045'',''31000000-0000-4000-8000-000000000031'',repeat(''a'',64))',:'other'),'P0001','FORBIDDEN','trusted verification checks seller attachment ownership');
select throws_ok(format('select api.verify_scrap_attachment(%L,''31000000-0000-4000-8000-000000000020'',''31000000-0000-4000-8000-000000000045'',''31000000-0000-4000-8000-000000000031'',repeat(''a'',64))',:'seller'),'P0001','ATTACHMENT_NOT_VERIFIED','trusted verification rejects object MIME mismatch');
reset role;
update storage.objects set metadata='{"size":4,"mimetype":"image/jpeg"}'
where bucket_id='scrap-evidence' and name=(:'attachment')::jsonb->>'storagePath';
set local role service_role;
select is(api.verify_scrap_attachment(:'seller','31000000-0000-4000-8000-000000000020','31000000-0000-4000-8000-000000000045','31000000-0000-4000-8000-000000000031',repeat('a',64))->>'status','verified','trusted service can verify uploaded evidence');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub',:'seller',true);
select is(jsonb_array_length(api.list_scrap_evidence(:'collection')),1,'only verified term appears as evidence');
select set_config('request.jwt.claim.sub',:'manager',true);
select api.save_scrap_point(jsonb_build_object('id',(:'point')::jsonb->>'id','name','Ponto TESTE renomeado','address','Novo endereco','active',false,'expectedVersion',1));
select is(api.list_scrap_operations()#>>'{collections,0,concentrationPoint,name}','Ponto TESTE','point update/inactivation preserves historical destination');
select set_config('request.jwt.claim.sub',:'other',true);
select throws_ok(format('select api.confirm_scrap_receipt(%L,''31000000-0000-4000-8000-000000000046'',''{"schemaVersion":1,"expectedVersion":1,"receivedWeightKg":"98","receivedLocation":"Matriz"}'')',:'collection'),'P0001','VALIDATION_FAILED','weight difference requires explanation');
select api.confirm_scrap_receipt(:'collection','31000000-0000-4000-8000-000000000041','{"schemaVersion":1,"expectedVersion":1,"receivedWeightKg":"98","receivedLocation":"Matriz","observation":"Diferença pesada"}') as receipt \gset
select is(api.confirm_scrap_receipt(:'collection','31000000-0000-4000-8000-000000000041','{"schemaVersion":1,"expectedVersion":1,"receivedWeightKg":"98","receivedLocation":"Matriz","observation":"Diferença pesada"}'),(:'receipt')::jsonb,'receipt replay does not create additional volume');
select is((select c->>'actualWeightKg' from jsonb_array_elements(api.list_scrap_operations()->'collections') c where c->>'id'=:'collection'),'100','original collection remains 100 kg');
select is((select c#>>'{receipt,receivedWeightKg}' from jsonb_array_elements(api.list_scrap_operations()->'collections') c where c->>'id'=:'collection'),'98','actual receipt remains separately 98 kg');
select is((select s->>'estimatedWeightKg' from jsonb_array_elements(api.list_scrap_operations()->'schedules') s where s->>'id'=((:'schedule')::jsonb->>'id')),'200','schedule is not counted as collection or receipt');
select throws_ok(format('select api.confirm_scrap_receipt(%L,''31000000-0000-4000-8000-000000000047'',''{"schemaVersion":1,"expectedVersion":1,"receivedWeightKg":"100","receivedLocation":"Matriz"}'')',:'collection'),'P0001','VERSION_CONFLICT','second acceptance conflicts');
select api.revise_pickup_schedule(((:'schedule')::jsonb->>'id')::uuid,'31000000-0000-4000-8000-000000000048','{"schemaVersion":1,"expectedVersion":1,"estimatedWeightKg":"220","desiredDate":"2099-10-11","period":"afternoon","reason":"Cliente solicitou nova data"}') as revised \gset
select is((:'revised')::jsonb->>'version','2','authorized schedule revision advances version');
reset role;
select is((select before_data->>'estimated_weight_kg' from api.pickup_schedule_revisions where schedule_id=((:'schedule')::jsonb->>'id')::uuid),'200','revision preserves original estimate');
select is((select difference_kg::text from api.scrap_receipts where collection_id=:'collection'),'-2','difference retained without changing original');
select ok((select retention_until>=last_event_at+interval '5 years' from api.scrap_collections where id=:'collection'),'closed custody keeps five years from last event');
select throws_ok(format('delete from api.scrap_collections where id=%L',:'collection'),'P0001','RETENTION_PROTECTED','historical collection cannot be deleted');
select set_config('storage.allow_delete_query','true',true);
select throws_ok(format('delete from storage.objects where bucket_id=''scrap-evidence'' and name=%L',(:'attachment')::jsonb->>'storagePath'),'P0001','RETENTION_PROTECTED','term storage metadata cannot be deleted');
select throws_ok(format('update api.scrap_collections set actual_weight_kg=101 where id=%L',:'collection'),'P0001','HISTORY_IMMUTABLE','original weight cannot be silently changed');
select is((select count(*)::integer from api.scrap_receipts where collection_id=:'collection'),1,'one final receipt exists');
select ok((select count(*)>0 from private.audit_events where target_id=:'collection' and action='scrap.received.v1'),'final receipt is audited');
set local role authenticated;
select set_config('request.jwt.claim.sub',:'other',true);
select throws_ok(format('select api.revise_scrap_receipt(%L,''31000000-0000-4000-8000-000000000060'',''{"schemaVersion":1,"expectedVersion":2,"receivedWeightKg":"100","receivedLocation":"Natal","reason":"Recontagem"}'')',:'collection'),'P0001','FORBIDDEN','logistics receipt permission does not authorize corrections');
select set_config('request.jwt.claim.sub',:'seller',true);
select throws_ok(format('select api.revise_scrap_receipt(%L,''31000000-0000-4000-8000-000000000060'',''{"schemaVersion":1,"expectedVersion":2,"receivedWeightKg":"100","receivedLocation":"Natal","reason":"Recontagem"}'')',:'collection'),'P0001','FORBIDDEN','seller cannot rewrite accepted weight');
select set_config('request.jwt.claim.sub',:'manager',true);
select throws_ok(format('select api.revise_scrap_receipt(%L,''31000000-0000-4000-8000-000000000060'',''{"schemaVersion":1,"expectedVersion":1,"receivedWeightKg":"100","receivedLocation":"Natal","reason":"Recontagem"}'')',:'collection'),'P0001','VERSION_CONFLICT','stale correction version conflicts');
select throws_ok(format('select api.revise_scrap_receipt(%L,''31000000-0000-4000-8000-000000000060'',''{"schemaVersion":1,"expectedVersion":2,"receivedWeightKg":"100","receivedLocation":"Natal"}'')',:'collection'),'P0001','VALIDATION_FAILED','correction requires explicit reason');
select api.revise_scrap_receipt(:'collection','31000000-0000-4000-8000-000000000060','{"schemaVersion":1,"expectedVersion":2,"receivedWeightKg":"100","receivedLocation":"Natal","reason":"Recontagem"}') as receipt_correction \gset
select is((:'receipt_correction')::jsonb->>'version','3','receipt correction advances shared collection version');
select is((:'receipt_correction')::jsonb->'receivedBy',(:'receipt')::jsonb->'receivedBy','correction preserves original receiver identity');
select is((:'receipt_correction')::jsonb->>'receivedAt',(:'receipt')::jsonb->>'receivedAt','correction preserves original receiver timestamp');
select jsonb_build_object('schemaVersion',1,'expectedVersion',3,'actualWeightKg','105','collectedAt',now(),'receiptNumber','TERMO TESTE corrigido','destinationType','headquarters','reason','Conferencia do termo') as correction_command \gset
select throws_ok(format('select api.revise_scrap_collection(%L,''31000000-0000-4000-8000-000000000061'',%L::jsonb)',:'collection',:'correction_command'),'P0001','VALIDATION_FAILED','new post-receipt divergence requires explanation');
select throws_ok(format('select api.revise_scrap_collection(%L,''31000000-0000-4000-8000-000000000061'',%L::jsonb)',:'collection',((:'correction_command')::jsonb||jsonb_build_object('collectedAt','2999-01-01T00:00:00Z','divergenceObservation','Teste'))::text),'P0001','VALIDATION_FAILED','correction cannot invent a future collection time');
select throws_ok(format('select api.revise_scrap_collection(%L,''31000000-0000-4000-8000-000000000061'',%L::jsonb)',:'collection',((:'correction_command')::jsonb||jsonb_build_object('destinationType','concentration_point','concentrationPointId','31000000-0000-4000-8000-000000000099','divergenceObservation','Teste'))::text),'P0001','VALIDATION_FAILED','correction cannot switch to nonexistent concentration point');
select throws_ok(format('do $test$ begin perform api.revise_scrap_collection(%L,''31000000-0000-4000-8000-000000000061'',%L::jsonb); raise exception using errcode=''Z0001'',message=''VALIDATED_AND_ROLLED_BACK''; end $test$',:'collection',((:'correction_command')::jsonb||jsonb_build_object('destinationType','concentration_point','concentrationPointId',(:'point')::jsonb->>'id','divergenceObservation','Teste'))::text),'Z0001','VALIDATED_AND_ROLLED_BACK','correction may keep original now-inactive point and snapshot');
select (:'correction_command')::jsonb||'{"divergenceObservation":"Peso de coleta conferido no termo"}'::jsonb as valid_correction \gset
select api.revise_scrap_collection(:'collection','31000000-0000-4000-8000-000000000061',(:'valid_correction')::jsonb) as collection_correction \gset
select is(api.revise_scrap_collection(:'collection','31000000-0000-4000-8000-000000000061',(:'valid_correction')::jsonb),(:'collection_correction')::jsonb,'correction replay is idempotent');
select throws_ok(format('select api.revise_scrap_collection(%L,''31000000-0000-4000-8000-000000000061'',%L::jsonb)',:'collection',((:'valid_correction')::jsonb||'{"actualWeightKg":"106"}'::jsonb)::text),'P0001','IDEMPOTENCY_KEY_REUSED','divergent correction replay conflicts');
select is(api.list_scrap_operations()#>>'{totals,collectedKg}','105','totals use corrected collection once');
select is(api.list_scrap_operations()#>>'{totals,receivedKg}','100','receipt corrected total remains separate');
select is(((api.list_scrap_operations()#>>'{totals,scheduledKg}')::numeric - (:'previous_scheduled')::numeric)::text,
  '232','corrections do not change future schedules, including the delayed request');
select api.revise_scrap_receipt(:'collection','31000000-0000-4000-8000-000000000062','{"schemaVersion":1,"expectedVersion":4,"receivedWeightKg":"103","receivedLocation":"Natal balanca","observation":"Revisao de pesagem","reason":"Balanca conferida"}') as final_receipt \gset
select is((:'final_receipt')::jsonb->>'version','5','later receipt correction uses shared version');
select is(jsonb_array_length(api.list_scrap_collection_revisions(:'collection')),3,'all three corrections retained without replay duplication');
select is(api.list_scrap_collection_revisions(:'collection')#>>'{0,before,receivedWeightKg}','98','first correction preserves original receipt weight');
select is(api.list_scrap_collection_revisions(:'collection')#>>'{1,before,actualWeightKg}','100','collection correction preserves original seller weight');
select ok(not((api.list_scrap_collection_revisions(:'collection')->0->'before') ?| array['deviceId','checksum','storagePath']),'revision reads expose only business fields');
reset role;
select is((select difference_kg::text from api.scrap_receipts where collection_id=:'collection'),'-2','difference recalculated from corrected weights');
select ok((select retention_until>=last_event_at+interval '5 years' and retention_until>((:'collection_correction')::jsonb->>'retentionUntil')::timestamptz from api.scrap_collections where id=:'collection'),'last correction extends retention without shortening');
select is((select cardinality(attachment_offline_ids) from api.scrap_collections where id=:'collection'),1,'corrections preserve original term attachments');
select is((select count(*)::integer from api.scrap_corrections where collection_id=:'collection'),3,'corrections remain append-only');
select throws_ok(format('delete from api.scrap_corrections where collection_id=%L',:'collection'),'P0001','RETENTION_PROTECTED','correction before/after history cannot be deleted');
do $audit_membership$ begin execute format('grant cirne_sync_executor to %I with set true granted by current_user',current_user); end $audit_membership$;
set local role cirne_sync_executor;
select throws_ok(format('delete from private.audit_events where target_id=%L and target_type=''scrap''',:'collection'),'P0001','RETENTION_PROTECTED','scrap audit events cannot be deleted');
reset role;
do $projection_membership$ begin execute format('grant cirne_scrap_executor to %I with set true granted by current_user',current_user); end $projection_membership$;
set local role cirne_scrap_executor;
select ok(not(private.scrap_revision_projection('{"actualWeightKg":"100","status":"awaiting_receipt","version":1,"receipt":null,"retentionUntil":null}') ?| array['receivedWeightKg','receivedLocation','receivedBy','receivedAt']),'pre-receipt revision omits unavailable optional receipt fields');
reset role;
update api.user_seller_scopes set revoked_at=now() where manager_user_id=:'manager' and seller_user_id=:'seller' and revoked_at is null;
set local role authenticated;
select set_config('request.jwt.claim.sub',:'manager',true);
select throws_ok(format('select api.revise_scrap_receipt(%L,''31000000-0000-4000-8000-000000000063'',''{"schemaVersion":1,"expectedVersion":5,"receivedWeightKg":"105","receivedLocation":"Natal","reason":"Fora do escopo"}'')',:'collection'),'P0001','NOT_FOUND','manager correction respects revoked seller scope');
select throws_ok(format('select api.list_scrap_collection_revisions(%L)',:'collection'),'P0001','NOT_FOUND','manager revision reads respect seller scope');
reset role;
select finish();
rollback;
