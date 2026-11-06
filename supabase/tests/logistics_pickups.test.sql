begin;
select no_plan();

select id as seller_a from auth.users where raw_user_meta_data->>'actorKey'='seller_a' order by created_at desc limit 1 \gset
select id as seller_b from auth.users where raw_user_meta_data->>'actorKey'='seller_b' order by created_at desc limit 1 \gset
select id as manager_a from auth.users where raw_user_meta_data->>'actorKey'='manager_a' order by created_at desc limit 1 \gset
select id as administrator from auth.users where raw_user_meta_data->>'actorKey'='administrator' order by created_at desc limit 1 \gset
select id as logistics_a from auth.users where raw_user_meta_data->>'actorKey'='logistics_a' order by created_at desc limit 1 \gset
select id as blocked from auth.users where raw_user_meta_data->>'actorKey'='blocked' order by created_at desc limit 1 \gset
select (clock_timestamp() at time zone 'America/Sao_Paulo')::date::text as today \gset
select ((clock_timestamp() at time zone 'America/Sao_Paulo')::date-1)::text as yesterday \gset
\set logistics_b '94170000-0000-4000-8000-000000000001'
\set client_a '94170000-0000-4000-8000-000000000002'
\set client_b '94170000-0000-4000-8000-000000000003'
\set first '94170000-0000-4000-8000-000000000011'
\set second '94170000-0000-4000-8000-000000000012'
\set third '94170000-0000-4000-8000-000000000013'
\set fourth '94170000-0000-4000-8000-000000000014'
\set fifth '94170000-0000-4000-8000-000000000015'
\set outside '94170000-0000-4000-8000-000000000016'
insert into auth.users(id,email) values(:'logistics_b','logistics-two-test@example.invalid');
insert into api.user_profiles(id,display_name) values(:'logistics_b','Operador B sintético');
insert into api.user_role_assignments(user_id,role_id,assigned_by)
  values(:'logistics_b','00000000-0000-4000-8000-000000000004',:'administrator');
insert into api.clients(id,external_reference,name,address,status) values
  (:'client_a','12345678000199','Cliente logística A','Endereço histórico A','active'),
  (:'client_b','LOGISTICS-TEST-B','Cliente logística B','Endereço B','active');
insert into api.client_seller_scopes(client_id,seller_id) values(:'client_a',:'seller_a'),(:'client_b',:'seller_b');
insert into api.pickup_schedules(id,offline_id,seller_id,device_id,client_id,client_name_snapshot,address_snapshot,
  seller_name_snapshot,estimated_weight_kg,desired_date,period,requested_at,origin)
select id,gen_random_uuid(),:'seller_a',gen_random_uuid(),:'client_a','Cliente logística A','Endereço histórico A',
  'Vendedor A',100,:'yesterday','morning',clock_timestamp()-interval '2 days','standalone'
from unnest(array[:'first'::uuid,:'second'::uuid,:'third'::uuid,:'fourth'::uuid,:'fifth'::uuid]) id;
insert into api.pickup_schedules(id,offline_id,seller_id,device_id,client_id,client_name_snapshot,address_snapshot,
  seller_name_snapshot,estimated_weight_kg,desired_date,period,requested_at,origin)
values(:'outside',gen_random_uuid(),:'seller_b',gen_random_uuid(),:'client_b','Cliente logística B','Endereço B',
  'Vendedor B',999,:'yesterday','morning',clock_timestamp()-interval '2 days','standalone');
insert into api.pickup_schedule_revisions(schedule_id,actor_id,reason,before_data,after_data)
select id,:'manager_a','Ajuste anterior ao despacho',jsonb_set(to_jsonb(s),'{estimated_weight_kg}','90'),to_jsonb(s)
from api.pickup_schedules s where s.id=:'first';

select ok(not has_table_privilege('authenticated','api.logistics_pickups','SELECT'),'authenticated cannot read pickup tables directly');
select ok(not has_table_privilege('authenticated','api.logistics_pickup_events','INSERT'),'authenticated cannot append arbitrary history');
select ok(not has_function_privilege('anon','api.change_logistics_pickup(uuid,text,uuid,jsonb)','EXECUTE'),'anonymous cannot execute pickup commands');
select ok(not has_function_privilege('authenticated','private.logistics_pickup_projection(uuid,boolean)','EXECUTE'),'private projection is not callable by users');

set local role authenticated;
select set_config('request.jwt.claim.sub',:'seller_a',true);
select throws_ok(format('select api.list_logistics_pickups(%L)',:'today'),'P0001','FORBIDDEN','seller cannot dispatch/read logistics route');
select set_config('request.jwt.claim.sub',:'blocked',true);
select throws_ok(format('select api.list_logistics_pickups(%L)',:'today'),'P0001','FORBIDDEN','blocked actor cannot read route');
select set_config('request.jwt.claim.sub',:'logistics_a',true);
select is(jsonb_array_length(api.list_logistics_pickups(:'today')->'records'),0,'operator sees no unassigned or global promises');
select throws_ok('select api.list_logistics_operators()','P0001','FORBIDDEN','operator cannot enumerate staff');
select set_config('request.jwt.claim.sub',:'manager_a',true);
select is((select count(*)::integer from jsonb_array_elements(api.list_logistics_pickups(:'today')->'records') r
  where r->>'scheduleId'=any(array[:'first',:'second',:'third',:'fourth',:'fifth'])),5,'overdue unassigned promises remain visible');
select is((select count(*)::integer from jsonb_array_elements(api.list_logistics_pickups(:'today')->'records') r
  where r->>'scheduleId'=:'outside'),0,'manager never reads another seller promise');
select ok(jsonb_array_length(api.list_logistics_operators()->'operators')>=2,'manager can select active logistics operators');
select jsonb_build_object('schemaVersion',1,'expectedVersion',1,'operatorId',:'logistics_a','routeDate',:'today','routeOrder',101,'reason','Primeiro despacho')::text as assign_first \gset
select api.change_logistics_pickup(:'first','assignment','94170000-0000-4000-8000-000000000101',:'assign_first') as first_assignment \gset
select is((:'first_assignment'::jsonb)->>'version','2','assignment increments schedule version');
select is((:'first_assignment'::jsonb)#>>'{client,document}','12345678000199','document comes from official client reference');
select is((:'first_assignment'::jsonb)#>>'{history,0,after,promisedWeightKg}','90','original schedule remains visible before its revision');
select is((:'first_assignment'::jsonb)->>'promisedWeightKg','100','dispatch snapshots the current promise after prior revision');
select is(api.change_logistics_pickup(:'first','assignment','94170000-0000-4000-8000-000000000101',:'assign_first'),:'first_assignment'::jsonb,'same assignment key replays canonical result');
select throws_ok(format('select api.change_logistics_pickup(%L,%L,%L,%L)',:'first','assignment','94170000-0000-4000-8000-000000000101',
  jsonb_set(:'assign_first'::jsonb,'{routeOrder}','102')::text),'P0001','IDEMPOTENCY_KEY_REUSED','same key with other contents is conflict');
select throws_ok(format('select api.change_logistics_pickup(%L,%L,%L,%L)',:'outside','assignment',gen_random_uuid(),:'assign_first'),
  'P0001','NOT_FOUND','known out-of-scope schedule cannot be assigned');
select throws_ok(format('select api.change_logistics_pickup(%L,%L,%L,%L)',:'second','assignment',gen_random_uuid(),:'assign_first'),
  'P0001','VERSION_CONFLICT','occupied route position cannot overwrite another stop');
select throws_ok(format('select api.change_logistics_pickup(%L,%L,%L,%L)',:'first','assignment',gen_random_uuid(),:'assign_first'),
  'P0001','VERSION_CONFLICT','stale version rejected');
select throws_ok(format('select api.change_logistics_pickup(%L,%L,%L,%L)',:'second','assignment',gen_random_uuid(),
  (:'assign_first'::jsonb||jsonb_build_object('operatorId',:'blocked','routeOrder',102))::text),
  'P0001','VALIDATION_FAILED','inactive/non-logistics assignee rejected');
select throws_ok(format('select api.change_logistics_pickup(%L,%L,%L,%L)',:'second','assignment',gen_random_uuid(),
  (:'assign_first'::jsonb||jsonb_build_object('routeOrder',102,'promisedWeightKg','1'))::text),
  'P0001','VALIDATION_FAILED','unknown mutation keys rejected directly by SQL');
select api.change_logistics_pickup(:'first','assignment',gen_random_uuid(),
  :'assign_first'::jsonb||jsonb_build_object('expectedVersion',2,'operatorId',:'logistics_b','reason','Troca de responsável')) as reassigned \gset
select set_config('request.jwt.claim.sub',:'logistics_a',true);
select throws_ok(format('select api.change_logistics_pickup(%L,%L,%L,%L)',:'first','result',gen_random_uuid(),
  jsonb_build_object('schemaVersion',1,'expectedVersion',3,'outcome','collected','actualWeightKg','100')::text),
  'P0001','NOT_FOUND','previous operator cannot execute reassigned stop');
select is((select count(*)::integer from jsonb_array_elements(api.list_logistics_pickups(:'today')->'records') r where r->>'scheduleId'=:'first'),0,
  'previous operator cannot read reassigned stop');
select set_config('request.jwt.claim.sub',:'manager_a',true);
select api.change_logistics_pickup(:'first','assignment',gen_random_uuid(),
  :'assign_first'::jsonb||jsonb_build_object('expectedVersion',3,'reason','Retorno ao operador A')) as restored \gset
select api.change_logistics_pickup(:'second','assignment',gen_random_uuid(),:'assign_first'::jsonb||jsonb_build_object('routeOrder',102)) as second_assignment \gset
select api.change_logistics_pickup(:'third','assignment',gen_random_uuid(),:'assign_first'::jsonb||jsonb_build_object('routeOrder',103)) as third_assignment \gset
select api.change_logistics_pickup(:'fourth','assignment',gen_random_uuid(),:'assign_first'::jsonb||jsonb_build_object('routeOrder',104)) as fourth_assignment \gset

reset role;
update api.clients set external_reference='12345678901',address='Endereço atual B' where id=:'client_a';
select throws_ok(format('update api.logistics_pickups set promised_weight_kg=80 where schedule_id=%L',:'first'),'P0001','HISTORY_IMMUTABLE','promise cannot be reduced after dispatch');
set local role authenticated;
select set_config('request.jwt.claim.sub',:'manager_a',true);
select throws_ok(format('select api.revise_pickup_schedule(%L,%L,%L)',:'first',gen_random_uuid(),
  jsonb_build_object('schemaVersion',1,'expectedVersion',4,'estimatedWeightKg','80','desiredDate',(:'today'::date+1)::text,'period','morning','reason','Esconder diferença')::text),
  'P0001','VERSION_CONFLICT','legacy schedule revision cannot rewrite dispatched promise');
select set_config('request.jwt.claim.sub',:'logistics_a',true);
select is((select r#>>'{client,document}' from jsonb_array_elements(api.list_logistics_pickups(:'today')->'records') r where r->>'scheduleId'=:'first'),
  '12345678000199','document snapshot survives a changed client record');
select is((select r#>>'{client,address}' from jsonb_array_elements(api.list_logistics_pickups(:'today')->'records') r where r->>'scheduleId'=:'first'),
  'Endereço histórico A','address remains dispatch snapshot');
select throws_ok(format('select api.change_logistics_pickup(%L,%L,%L,%L)',:'first','result',gen_random_uuid(),
  jsonb_build_object('schemaVersion',1,'expectedVersion',4,'outcome','collected','actualWeightKg','80')::text),
  'P0001','VALIDATION_FAILED','partial weight requires reason in database');
select throws_ok(format('select api.change_logistics_pickup(%L,%L,%L,%L)',:'first','result',gen_random_uuid(),
  jsonb_build_object('schemaVersion',1,'expectedVersion',4,'outcome','not_collected','actualWeightKg','1','reason','Ausente')::text),
  'P0001','VALIDATION_FAILED','not collected cannot report nonzero kilograms');
select jsonb_build_object('schemaVersion',1,'expectedVersion',4,'outcome','collected','actualWeightKg','80','reason','Cliente disponibilizou menos peso') as partial_command \gset
select api.change_logistics_pickup(:'first','result','94170000-0000-4000-8000-000000000105',:'partial_command') as partial_result \gset
select is((:'partial_result'::jsonb)#>>'{result,differenceKg}','-20','partial actual weight stays distinct from 100 kg promise');
select is((:'partial_result'::jsonb)->>'reviewRequired','true','partial result requires manager review');
select is(api.change_logistics_pickup(:'first','result','94170000-0000-4000-8000-000000000105',:'partial_command'),:'partial_result'::jsonb,
  'lost result response can be replayed without duplicate volume');
select api.change_logistics_pickup(:'second','result',gen_random_uuid(),jsonb_build_object('schemaVersion',1,'expectedVersion',2,'outcome','collected','actualWeightKg','100')) as exact_result \gset
select is((:'exact_result'::jsonb)->>'reviewRequired','false','100 kg fulfills 100 kg promise without review');
select api.change_logistics_pickup(:'third','result',gen_random_uuid(),jsonb_build_object('schemaVersion',1,'expectedVersion',2,'outcome','collected','actualWeightKg','120','reason','Mais material disponível')) as above_result \gset
select is((:'above_result'::jsonb)#>>'{result,differenceKg}','20','above promise retains positive difference');
select api.change_logistics_pickup(:'fourth','result',gen_random_uuid(),jsonb_build_object('schemaVersion',1,'expectedVersion',2,'outcome','not_collected','actualWeightKg','0','reason','Cliente fechado')) as zero_result \gset
select is((:'zero_result'::jsonb)#>>'{result,outcome}','not_collected','zero attempt is never a completed collection');
select is((:'zero_result'::jsonb)#>>'{result,differenceKg}','-100','no collection retains full promise shortfall');
select throws_ok(format('select api.change_logistics_pickup(%L,%L,%L,%L)',:'first','review',gen_random_uuid(),
  jsonb_build_object('schemaVersion',1,'expectedVersion',5,'reason','Revisado pelo operador')::text),'P0001','FORBIDDEN','operator cannot review own discrepancy');

select set_config('request.jwt.claim.sub',:'manager_a',true);
select api.change_logistics_pickup(:'first','review',gen_random_uuid(),jsonb_build_object('schemaVersion',1,'expectedVersion',5,'reason','Conferido com vendedor; sem nova viagem')) as reviewed \gset
select is((:'reviewed'::jsonb)->>'reviewRequired','false','manager review acknowledges discrepancy without changing weight');
select is((:'reviewed'::jsonb)#>>'{result,actualWeightKg}','80','review never edits actual kilograms');
select jsonb_build_object('schemaVersion',1,'expectedVersion',6,'outcome','collected','actualWeightKg','85','reason','Correção de erro de digitação conferida') as correction_command \gset
select api.change_logistics_pickup(:'first','correction','94170000-0000-4000-8000-000000000106',:'correction_command') as corrected \gset
select is((:'corrected'::jsonb)#>>'{result,actualWeightKg}','85','correction updates effective kilograms');
select is((:'corrected'::jsonb)#>>'{resultOriginal,actualWeightKg}','80','original actual kilograms remain immutable');
select is((:'corrected'::jsonb)#>>'{resultOriginal,recordedBy,id}',:'logistics_a','original operator identity preserved');
select is((:'corrected'::jsonb)#>>'{result,recordedBy,id}',:'manager_a','correction actor is distinct from original operator');
select is((:'corrected'::jsonb)->>'reviewRequired','true','correction invalidates previous review');
select is((:'corrected'::jsonb)->'review','null'::jsonb,'previous review not silently carried to corrected result');
select is(api.change_logistics_pickup(:'first','correction','94170000-0000-4000-8000-000000000106',:'correction_command'),:'corrected'::jsonb,'correction replay does not add result revision');
select is((select count(*)::integer from jsonb_array_elements((:'corrected'::jsonb)->'history') event where event->>'action'='result_corrected'),1,'one correction event survives replay');
select throws_ok(format('select api.change_logistics_pickup(%L,%L,%L,%L)',:'first','review',gen_random_uuid(),
  jsonb_build_object('schemaVersion',1,'expectedVersion',6,'reason','Versão antiga')::text),'P0001','VERSION_CONFLICT','stale review cannot cover new outcome');
select throws_ok(format('select api.change_logistics_pickup(%L,%L,%L,%L)',:'first','assignment',gen_random_uuid(),
  :'assign_first'::jsonb||jsonb_build_object('expectedVersion',7)),'P0001','VERSION_CONFLICT','completed attempt cannot be dispatched again');
select is((select count(*)::integer from jsonb_array_elements(api.list_scrap_operations()->'schedules') r
  where r->>'id'=any(array[:'first',:'second',:'third',:'fourth'])),0,'legacy pending operations exclude ended logistics attempts');
select is((select count(*)::integer from jsonb_array_elements(api.get_scrap_agenda(:'yesterday',:'yesterday','pending',null,null,null,null)->'records') r
  where r->>'id'=any(array[:'first',:'second',:'third',:'fourth'])),0,'pending agenda also excludes ended attempts');
select api.list_logistics_pickups(:'today') as manager_list \gset
select is((select sum((r#>>'{result,actualWeightKg}')::numeric)::text from jsonb_array_elements(:'manager_list'::jsonb->'records') r
  where r->>'scheduleId'=any(array[:'first',:'second',:'third',:'fourth',:'fifth'])),'305','only effective outcomes contribute actual total');
select is((select sum((r#>>'{result,differenceKg}')::numeric)::text from jsonb_array_elements(:'manager_list'::jsonb->'records') r
  where r->>'scheduleId'=any(array[:'first',:'second',:'third',:'fourth',:'fifth'])),'-95','difference excludes unexecuted promise and does not double-count correction');

reset role;
select is((select status from api.pickup_schedules where id=:'fourth'),'completed','not-collected means ended attempt in technical schedule state');
select ok((select retention_until>=last_event_at+interval '5 years' from api.pickup_schedules where id=:'first'),'correction extends five-year retention');
select is((select count(*)::integer from api.scrap_collections where client_id=:'client_a'),0,'logistics outcomes never create seller collections');
select throws_ok(format('update api.logistics_pickup_events set reason=%L where schedule_id=%L','Edited',:'first'),'P0001','HISTORY_IMMUTABLE','event history cannot be overwritten');
select throws_ok(format('delete from api.logistics_pickups where schedule_id=%L',:'first'),'P0001','RETENTION_PROTECTED','logistics records cannot be deleted');
update api.user_role_assignments set revoked_at=clock_timestamp() where user_id=:'logistics_a' and role_id='00000000-0000-4000-8000-000000000004';
set local role authenticated;
select set_config('request.jwt.claim.sub',:'logistics_a',true);
select throws_ok(format('select api.change_logistics_pickup(%L,%L,%L,%L)',:'first','result','94170000-0000-4000-8000-000000000105',:'partial_command'),
  'P0001','FORBIDDEN','revoked operator cannot replay private result');
select throws_ok(format('select api.list_logistics_pickups(%L)',:'today'),'P0001','FORBIDDEN','revoked role cannot reopen route');
reset role;
select * from finish();
rollback;
