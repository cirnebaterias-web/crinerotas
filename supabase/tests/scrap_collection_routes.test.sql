begin;
select no_plan();

select id as seller_a from auth.users where raw_user_meta_data->>'actorKey'='seller_a' order by created_at desc limit 1 \gset
select id as manager_a from auth.users where raw_user_meta_data->>'actorKey'='manager_a' order by created_at desc limit 1 \gset
select id as logistics_a from auth.users where raw_user_meta_data->>'actorKey'='logistics_a' order by created_at desc limit 1 \gset
select id as blocked from auth.users where raw_user_meta_data->>'actorKey'='blocked' order by created_at desc limit 1 \gset
\set client_a '94230000-0000-4000-8000-000000000001'
\set client_b '94230000-0000-4000-8000-000000000002'
\set client_c '94230000-0000-4000-8000-000000000003'
\set first '94230000-0000-4000-8000-000000000011'
\set second '94230000-0000-4000-8000-000000000012'
\set pending '94230000-0000-4000-8000-000000000013'
\set route_key '94230000-0000-4000-8000-000000000101'

insert into api.clients(id,external_reference,name,address,status,location) values
  (:'client_a','12345678000190','Cliente rota A','Rua A','active',extensions.st_setsrid(extensions.st_makepoint(-35.20,-5.80),4326)::extensions.geography),
  (:'client_b','12345678000191','Cliente rota B','Rua B','active',extensions.st_setsrid(extensions.st_makepoint(-35.30,-5.90),4326)::extensions.geography),
  (:'client_c','12345678000192','Cliente sem coordenada','Rua C','active',null);
insert into api.client_seller_scopes(client_id,seller_id) values
  (:'client_a',:'seller_a'),(:'client_b',:'seller_a'),(:'client_c',:'seller_a');
insert into api.pickup_schedules(id,offline_id,seller_id,device_id,client_id,client_name_snapshot,address_snapshot,
  seller_name_snapshot,estimated_weight_kg,desired_date,period,requested_at,origin) values
  (:'first',gen_random_uuid(),:'seller_a',gen_random_uuid(),:'client_a','Cliente rota A','Rua A','Vendedor A',100,current_date,'morning',now(),'standalone'),
  (:'second',gen_random_uuid(),:'seller_a',gen_random_uuid(),:'client_b','Cliente rota B','Rua B','Vendedor A',200,current_date,'morning',now(),'standalone'),
  (:'pending',gen_random_uuid(),:'seller_a',gen_random_uuid(),:'client_c','Cliente sem coordenada','Rua C','Vendedor A',300,current_date,'afternoon',now(),'standalone');

select ok(not has_table_privilege('authenticated','api.scrap_collection_routes','SELECT'),
  'authenticated cannot read route aggregates directly');
select ok(not has_table_privilege('authenticated','api.scrap_collection_route_events','INSERT'),
  'authenticated cannot forge route audit events');
select ok(not has_function_privilege('anon','api.create_scrap_collection_route(uuid,jsonb)','EXECUTE'),
  'anonymous cannot create collection routes');
select ok(not has_function_privilege('authenticated','private.scrap_collection_route_projection(uuid)','EXECUTE'),
  'private route projection is not callable by users');

set local role authenticated;
select set_config('request.jwt.claim.sub',:'blocked',true);
select throws_ok(format('select api.list_scrap_collection_routes(%L)',current_date),'P0001','FORBIDDEN',
  'blocked actor cannot inspect routes');
select set_config('request.jwt.claim.sub',:'manager_a',true);
select jsonb_build_object('schemaVersion',1,'routeDate',current_date,
  'scheduleIds',jsonb_build_array(:'first',:'second',:'pending')) as create_command \gset
select api.create_scrap_collection_route(:'route_key',:'create_command') as created \gset
select is((:'created'::jsonb)->>'version','1','new route starts at version one');
select is((:'created'::jsonb)->>'status','draft','new route requires manager approval');
select is((:'created'::jsonb)#>>'{counts,total}','3','all selected promises become stops');
select is((:'created'::jsonb)#>>'{counts,pendingLocation}','3',
  'imported client coordinates remain pending until observed in a visit');
select is((select count(*)::integer from jsonb_array_elements(:'created'::jsonb->'stops') stop
  where stop->>'geographyStatus'='pending_location'),3,'dubious coordinates never receive invented distance');
select api.create_scrap_collection_route(:'route_key',:'create_command') as replay \gset
select is(:'replay'::jsonb,:'created'::jsonb,'same create key replays canonical route');
select throws_ok(format('select api.create_scrap_collection_route(%L,%L)',:'route_key',
  (:'create_command'::jsonb||jsonb_build_object('routeDate',current_date+1))::text),
  'P0001','IDEMPOTENCY_KEY_REUSED','same key cannot represent another route');
select (:'created'::jsonb)->>'routeId' as route_id \gset
reset role;
savepoint recompute_swap;
update api.scrap_collection_route_stops set location_snapshot=case schedule_id
  when :'first' then extensions.st_setsrid(extensions.st_makepoint(-35.20,-5.80),4326)::extensions.geography
  when :'second' then extensions.st_setsrid(extensions.st_makepoint(-36.00,-5.80),4326)::extensions.geography
  else extensions.st_setsrid(extensions.st_makepoint(-35.21,-5.80),4326)::extensions.geography end
  where route_id=:'route_id' and active;
grant cirne_scrap_executor to postgres with set true;
set local role cirne_scrap_executor;
select lives_ok(format('select private.scrap_collection_route_recompute(%L)',:'route_id'),
  'recompute safely swaps active orders without transient uniqueness collisions');
reset role;
select is((select planned_order from api.scrap_collection_route_stops
  where route_id=:'route_id' and schedule_id=:'second' and active),1,
  'recompute applies the new deterministic order after staging the complete result');
rollback to recompute_swap;
set local role authenticated;
select set_config('request.jwt.claim.sub',:'manager_a',true);
select throws_ok(format('select api.create_scrap_collection_route(%L,%L)',gen_random_uuid(),:'create_command'),
  'P0001','VALIDATION_FAILED','one promise cannot be placed in two routes');
select jsonb_build_object('schemaVersion',1,'expectedVersion',1,'reason','Ordem operacional',
  'stops',jsonb_build_array(
    jsonb_build_object('scheduleId',:'pending','plannedOrder',1),
    jsonb_build_object('scheduleId',:'second','plannedOrder',2),
    jsonb_build_object('scheduleId',:'first','plannedOrder',3))) as reorder_command \gset
select api.change_scrap_collection_route(:'route_id','reorder',gen_random_uuid(),:'reorder_command') as reordered \gset
select is((:'reordered'::jsonb)->>'version','2','manual reorder increments route version');
select is((:'reordered'::jsonb)#>>'{stops,0,scheduleId}',:'pending','projection follows manager-approved planned order');
select throws_ok(format('select api.change_scrap_collection_route(%L,%L,%L,%L)',:'route_id','approve',gen_random_uuid(),
  jsonb_build_object('schemaVersion',1,'expectedVersion',1,'reason','Versão antiga')::text),
  'P0001','VERSION_CONFLICT','stale manager mutation cannot overwrite current version');
select api.change_scrap_collection_route(:'route_id','approve',gen_random_uuid(),
  jsonb_build_object('schemaVersion',1,'expectedVersion',2,'reason','Rota conferida')) as approved \gset
select is((:'approved'::jsonb)->>'status','approved','manager approval is explicit');
select api.change_scrap_collection_route(:'route_id','assign',gen_random_uuid(),
  jsonb_build_object('schemaVersion',1,'expectedVersion',3,'operatorId',:'logistics_a','reason','Escala do dia')) as assigned \gset
select is((:'assigned'::jsonb)->>'status','assigned','approved route can be assigned');
select is((:'assigned'::jsonb)->>'operatorId',:'logistics_a','operator assignment preserves route identity');
select is((:'assigned'::jsonb)->>'routeId',:'route_id','assignment does not replace route id');
reset role;
select is((select count(*)::integer from api.logistics_pickups pickup join api.scrap_collection_route_stops stop
  on stop.schedule_id=pickup.schedule_id where stop.route_id=:'route_id'),3,
  'assignment bridges every route stop to the existing logistics execution truth');
select is((select promised_weight_kg::text from api.logistics_pickups where schedule_id=:'first'),'100',
  'dispatched promise equals the immutable route snapshot');

set local role authenticated;
select set_config('request.jwt.claim.sub',:'manager_a',true);
select api.change_scrap_collection_route(:'route_id','revise',gen_random_uuid(),jsonb_build_object(
  'schemaVersion',1,'expectedVersion',4,'reason','Cliente retirado antes da saída',
  'scheduleIds',jsonb_build_array(:'pending',:'second'))) as removed_stop \gset
select is((:'removed_stop'::jsonb)#>>'{counts,total}','2',
  'manager can remove an unexecuted stop while preserving route identity');
select is((:'removed_stop'::jsonb)->>'status','draft',
  'changing dispatched composition invalidates the previous approval');
select set_config('request.jwt.claim.sub',:'logistics_a',true);
select is(jsonb_array_length(api.list_logistics_pickups(current_date)->'records'),0,
  'revised route leaves the operator phone until the new version is approved and assigned');
select set_config('request.jwt.claim.sub',:'manager_a',true);
savepoint active_reassignment;
select api.create_scrap_collection_route(gen_random_uuid(),jsonb_build_object(
  'schemaVersion',1,'routeDate',current_date,'scheduleIds',jsonb_build_array(:'first'))) as reassigned_route \gset
select is((:'reassigned_route'::jsonb)#>>'{counts,total}','1',
  'a schedule archived from the previous route can be assigned to a new active route');
reset role;
select is((select count(*)::integer from api.scrap_collection_route_stops
  where schedule_id=:'first' and active),1,
  'only one active route stop owns a reassigned schedule');
rollback to active_reassignment;
set local role authenticated;
select set_config('request.jwt.claim.sub',:'manager_a',true);
select api.change_scrap_collection_route(:'route_id','revise',gen_random_uuid(),jsonb_build_object(
  'schemaVersion',1,'expectedVersion',5,'reason','Cliente reincluído pelo gestor',
  'scheduleIds',jsonb_build_array(:'pending',:'second',:'first'))) as restored_stop \gset
select is((:'restored_stop'::jsonb)#>>'{counts,total}','3',
  'manager can add a pending stop as a new route version');
select api.change_scrap_collection_route(:'route_id','reorder',gen_random_uuid(),jsonb_build_object(
  'schemaVersion',1,'expectedVersion',6,'reason','Ajuste antes da saída','stops',jsonb_build_array(
    jsonb_build_object('scheduleId',:'first','plannedOrder',1),
    jsonb_build_object('scheduleId',:'second','plannedOrder',2),
    jsonb_build_object('scheduleId',:'pending','plannedOrder',3)))) as dispatched_reorder \gset
select api.change_scrap_collection_route(:'route_id','approve',gen_random_uuid(),jsonb_build_object(
  'schemaVersion',1,'expectedVersion',7,'reason','Nova versão conferida')) as reapproved \gset
select api.change_scrap_collection_route(:'route_id','assign',gen_random_uuid(),jsonb_build_object(
  'schemaVersion',1,'expectedVersion',8,'operatorId',:'logistics_a','reason','Nova versão despachada')) as reassigned \gset
select is((select record#>>'{assignment,routeOrder}'
  from jsonb_array_elements(api.list_logistics_pickups(current_date)->'records') record
  where record->>'scheduleId'=:'first'),'1','reordering an assigned route synchronizes logistics execution order');
select set_config('request.jwt.claim.sub',:'logistics_a',true);
select is(jsonb_array_length(api.list_scrap_collection_routes(current_date)->'routes'),1,
  'operator reads only the route assigned to that identity');
select api.change_logistics_pickup(:'pending','result',gen_random_uuid(),jsonb_build_object(
  'schemaVersion',1,'expectedVersion',3,'outcome','collected','actualWeightKg','300')) as first_result \gset
select set_config('request.jwt.claim.sub',:'manager_a',true);
select is((api.get_scrap_collection_route(:'route_id'))->>'status','in_progress',
  'one completed stop starts but does not close a route with pending stops');
select set_config('request.jwt.claim.sub',:'logistics_a',true);
select api.change_logistics_pickup(:'second','result',gen_random_uuid(),jsonb_build_object(
  'schemaVersion',1,'expectedVersion',3,'outcome','not_collected','actualWeightKg','0','reason','Cliente fechado')) as second_result \gset
select set_config('request.jwt.claim.sub',:'manager_a',true);
select is((api.get_scrap_collection_route(:'route_id'))->>'status','in_progress',
  'executing an intermediate stop still leaves the route open');
select set_config('request.jwt.claim.sub',:'logistics_a',true);
select api.change_logistics_pickup(:'first','result',gen_random_uuid(),jsonb_build_object(
  'schemaVersion',1,'expectedVersion',3,'outcome','collected','actualWeightKg','100')) as last_result \gset
select set_config('request.jwt.claim.sub',:'manager_a',true);
select is((api.get_scrap_collection_route(:'route_id'))->>'status','completed',
  'route closes automatically only after every current stop is terminal');
select is((api.get_scrap_collection_route(:'route_id'))->>'version','11',
  'start and completion each register a route version');

reset role;
select is((select count(*)::integer from api.scrap_collection_route_events where route_id=:'route_id'),11,
  'managerial revisions, renewed approval, actions, start and completion append eleven audit events');
select throws_ok(format('delete from api.scrap_collection_routes where id=%L',:'route_id'),
  'P0001','RETENTION_PROTECTED','route history cannot be deleted');
select throws_ok(format('update api.scrap_collection_route_events set reason=%L where route_id=%L','Editado',:'route_id'),
  'P0001','HISTORY_IMMUTABLE','route audit cannot be rewritten');

select * from finish();
rollback;
