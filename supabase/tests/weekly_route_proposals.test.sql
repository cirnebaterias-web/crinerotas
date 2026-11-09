begin;

select plan(39);

select has_table('api','weekly_route_proposals','weekly proposals exist');
select has_table('api','seller_daily_route_locations','daily seller locations exist');
select has_function('api','save_weekly_route_proposal',array['jsonb'],'save RPC exists');
select has_function('api','revise_weekly_route_proposal',array['uuid','jsonb'],'revise RPC exists');
select has_function('api','decide_weekly_route_proposal',array['uuid','jsonb'],'decision RPC exists');
select has_function('api','capture_daily_seller_location',array['jsonb'],'location RPC exists');
select ok(not has_table_privilege('authenticated','api.weekly_route_proposals','SELECT'),
  'authenticated cannot bypass proposal RPCs');

select id as seller_id from auth.users where raw_user_meta_data ->> 'actorKey'='seller_a' \gset
select id as manager_id from auth.users where raw_user_meta_data ->> 'actorKey'='manager_a' \gset

set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_id', true);

select jsonb_build_object(
  'schemaVersion',1,'idempotencyKey','91111111-1111-4111-8111-111111111111',
  'proposal',jsonb_build_object(
    'schemaVersion',1,'mode','rules','weekStart','2026-11-09','sellerId',:'seller_id',
    'generatedAt','2026-11-05T12:00:00Z',
    'policy',jsonb_build_object('version','weekly-route-rules-v2','inactiveAfterDays',180,'dailyClientLimit',10,
      'dailyGpsMaxAgeMinutes',5,'dailyGpsMaxAccuracyM',100,
      'weights',jsonb_build_object('recency',50,'volume',15,'scrapDebt',20,'proximity',15)),
    'origin',jsonb_build_object('kind','base_city','sellerId',:'seller_id','city','Natal','state','RN',
      'ibgeCode','2408102','configVersion',1,'latitude',-5.83,'longitude',-35.21,
      'reference','municipal_seat','source','IBGE'),
    'sources',jsonb_build_object('sales',jsonb_build_object('status','unavailable','generationId',null,'asOfDate',null),
      'scrap',jsonb_build_object('status','unavailable','generationId',null,'publishedAt',null)),
    'days',jsonb_build_array(
      jsonb_build_object('dayIndex',0,'serviceDate','2026-11-09','suggestions',jsonb_build_array()),
      jsonb_build_object('dayIndex',1,'serviceDate','2026-11-10','suggestions',jsonb_build_array()),
      jsonb_build_object('dayIndex',2,'serviceDate','2026-11-11','suggestions',jsonb_build_array()),
      jsonb_build_object('dayIndex',3,'serviceDate','2026-11-12','suggestions',jsonb_build_array()),
      jsonb_build_object('dayIndex',4,'serviceDate','2026-11-13','suggestions',jsonb_build_array())),
    'excluded',jsonb_build_array(),'counts',jsonb_build_object('evaluated',0,'suggested',0,
      'inactiveLost',0,'noPurchaseHistory',0,'needsReview',0))) as save_command \gset

select api.save_weekly_route_proposal(:'save_command'::jsonb) as saved \gset
select is(:'saved'::jsonb ->> 'status','draft','generated proposal remains unpublished');
select is(:'saved'::jsonb ->> 'version','1','first proposal version is one');
select is(api.save_weekly_route_proposal(:'save_command'::jsonb) ->> 'proposalId',
  :'saved'::jsonb ->> 'proposalId','same save command replays');

select throws_ok(format($sql$select api.save_weekly_route_proposal(%L::jsonb)$sql$,
  jsonb_set(:'save_command'::jsonb,'{idempotencyKey}','"91111111-1111-4111-8111-111111111112"'::jsonb)
    #- '{proposal,schemaVersion}'), 'P0001','VALIDATION_FAILED','proposal requires schemaVersion');
select throws_ok(format($sql$select api.save_weekly_route_proposal(%L::jsonb)$sql$,
  jsonb_set(:'save_command'::jsonb,'{idempotencyKey}','"91111111-1111-4111-8111-111111111113"'::jsonb)
    #- '{proposal,origin,latitude}'), 'P0001','VALIDATION_FAILED','proposal requires origin latitude');
select throws_ok(format($sql$select api.save_weekly_route_proposal(%L::jsonb)$sql$,
  jsonb_set(:'save_command'::jsonb,'{idempotencyKey}','"91111111-1111-4111-8111-111111111114"'::jsonb)
    #- '{proposal,policy,dailyGpsMaxAccuracyM}'), 'P0001','VALIDATION_FAILED','proposal requires daily GPS policy');
select throws_ok(format($sql$select api.save_weekly_route_proposal(%L::jsonb)$sql$,
  jsonb_set(:'save_command'::jsonb,'{idempotencyKey}','"91111111-1111-4111-8111-111111111115"'::jsonb)
    #- '{proposal,counts,needsReview}'), 'P0001','VALIDATION_FAILED','proposal requires every count');

select api.revise_weekly_route_proposal((:'saved'::jsonb ->> 'proposalId')::uuid,jsonb_build_object(
  'schemaVersion',1,'idempotencyKey','92222222-2222-4222-8222-222222222222','expectedVersion',1,
  'days',:'saved'::jsonb #> '{proposal,days}')) as revised \gset
select is(:'revised'::jsonb ->> 'version','2','revision increments optimistic version');
select throws_ok(format($sql$select api.revise_weekly_route_proposal(%L::uuid,%L::jsonb)$sql$,
  :'saved'::jsonb ->> 'proposalId',jsonb_build_object('schemaVersion',1,
  'idempotencyKey','93333333-3333-4333-8333-333333333333','expectedVersion',1,
  'days',:'saved'::jsonb #> '{proposal,days}')), 'P0001','VERSION_CONFLICT','stale revision conflicts');

select api.decide_weekly_route_proposal((:'saved'::jsonb ->> 'proposalId')::uuid,jsonb_build_object(
  'schemaVersion',1,'idempotencyKey','94444444-4444-4444-8444-444444444444',
  'expectedVersion',2,'decision','reject','reason','Semana será refeita.')) as rejected \gset
select is(:'rejected'::jsonb ->> 'status','rejected','manager can reject with reason');
reset role;
select is((select count(*)::integer from private.audit_events where target_type='weekly_route_proposal'
  and target_id=(:'saved'::jsonb ->> 'proposalId')::uuid),3,'save revise and decision are audited once');

do $test_executor_role$
begin
  execute pg_catalog.format('grant cirne_route_executor to %I with set true granted by current_user',current_user);
end
$test_executor_role$;
set local role cirne_route_executor;
select lives_ok(format($sql$select private.validate_weekly_route_proposal(%L::uuid,%L::date,%L::jsonb)$sql$,
  :'seller_id','2026-11-09',jsonb_set(jsonb_set(jsonb_set(:'save_command'::jsonb -> 'proposal',
    '{excluded}',jsonb_build_array(jsonb_build_object('clientId','97777777-7777-4777-8777-777777777777',
      'reason','daily_distance_limit'))),'{counts,evaluated}','1'::jsonb),'{counts,needsReview}','1'::jsonb)),
  'distance-limited clients remain valid proposal exclusions');
select lives_ok(format($sql$select private.validate_weekly_route_proposal(%L::uuid,%L::date,%L::jsonb)$sql$,
  :'seller_id','2026-11-09',jsonb_set(jsonb_set(jsonb_set(:'save_command'::jsonb -> 'proposal',
    '{excluded}',jsonb_build_array(jsonb_build_object('clientId','97777777-7777-4777-8777-777777777777',
      'reason','daily_capacity_reached'))),'{counts,evaluated}','1'::jsonb),'{counts,needsReview}','1'::jsonb)),
  'capacity-limited clients remain valid proposal exclusions');
reset role;
do $test_executor_role$
begin
  execute pg_catalog.format('revoke cirne_route_executor from %I granted by current_user',current_user);
end
$test_executor_role$;

set local role authenticated;
select set_config('request.jwt.claim.sub', :'seller_id', true);
select api.capture_daily_seller_location(jsonb_build_object('schemaVersion',1,
  'idempotencyKey','95555555-5555-4555-8555-555555555555','latitude',-5.8,'longitude',-35.2,
  'accuracyM',25,'capturedAt',clock_timestamp())) as location \gset
select is(:'location'::jsonb ->> 'sellerId',:'seller_id','seller records only its own location');
select is(:'location'::jsonb ->> 'version','1','first daily location has version one');
select throws_ok($sql$select api.capture_daily_seller_location(jsonb_build_object('schemaVersion',1,
  'idempotencyKey','96666666-6666-4666-8666-666666666666','latitude',-5.8,'longitude',-35.2,
  'accuracyM',101,'capturedAt',clock_timestamp()))$sql$,'P0001','VALIDATION_FAILED',
  'location above configured accuracy is rejected');
reset role;

do $test_roles$
begin
  execute pg_catalog.format('grant cirne_administration_executor to %I with set true granted by current_user',current_user);
  execute pg_catalog.format('grant service_role to %I with set true granted by current_user',current_user);
end
$test_roles$;
set local role cirne_administration_executor;
insert into api.seller_route_profiles(seller_id,base_city,base_state,base_ibge_code,base_latitude,base_longitude,updated_by)
values(:'seller_id','Natal','RN','2408102',-5.83,-35.21,:'manager_id');
reset role;
set local role service_role;
insert into api.clients(id,external_reference,name,address,status)
values('97777777-7777-4777-8777-777777777777','12345678901234','Cliente da carteira','Rua válida','active');
insert into api.client_seller_scopes(client_id,seller_id,assigned_by)
values('97777777-7777-4777-8777-777777777777',:'seller_id',:'manager_id');
reset role;

select jsonb_set(jsonb_set(:'save_command'::jsonb,'{idempotencyKey}',
  '"98888888-8888-4888-8888-888888888888"'::jsonb),'{proposal}',
  jsonb_set(jsonb_set(jsonb_set(:'save_command'::jsonb -> 'proposal','{weekStart}','"2026-11-16"'::jsonb),
    '{generatedAt}','"2026-11-05T13:00:00Z"'::jsonb),'{days}',jsonb_build_array(
      jsonb_build_object('dayIndex',0,'serviceDate','2026-11-16','suggestions',jsonb_build_array(
        jsonb_build_object('clientId','97777777-7777-4777-8777-777777777777','name','Cliente da carteira',
          'dayIndex',0,'plannedOrder',1,'score',80,'approximateDistanceKm',1,'reasons',jsonb_build_array('oportunidade'),
          'locationPending',false,'scrapBalanceState','settled'))),
      jsonb_build_object('dayIndex',1,'serviceDate','2026-11-17','suggestions',jsonb_build_array()),
      jsonb_build_object('dayIndex',2,'serviceDate','2026-11-18','suggestions',jsonb_build_array()),
      jsonb_build_object('dayIndex',3,'serviceDate','2026-11-19','suggestions',jsonb_build_array()),
      jsonb_build_object('dayIndex',4,'serviceDate','2026-11-20','suggestions',jsonb_build_array())))) as publish_command \gset
select jsonb_set(jsonb_set(:'publish_command'::jsonb,'{proposal,counts,evaluated}','1'::jsonb),
  '{proposal,counts,suggested}','1'::jsonb) as publish_command \gset

set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_id', true);
select throws_ok(format($sql$select api.save_weekly_route_proposal(%L::jsonb)$sql$,
  jsonb_set(:'publish_command'::jsonb,'{idempotencyKey}','"98888888-8888-4888-8888-888888888889"'::jsonb)
    #- '{proposal,days,0,suggestions,0,locationPending}'), 'P0001','VALIDATION_FAILED',
  'proposal requires every suggestion field');
select api.save_weekly_route_proposal(:'publish_command'::jsonb) as publish_draft \gset
select is(:'publish_draft'::jsonb ->> 'status','draft','publishable proposal starts as draft');
select throws_ok(format($sql$select api.revise_weekly_route_proposal(%L::uuid,%L::jsonb)$sql$,
  :'publish_draft'::jsonb ->> 'proposalId',jsonb_build_object('schemaVersion',1,
  'idempotencyKey','9ccccccc-cccc-4ccc-8ccc-cccccccccccc','expectedVersion',1,'days',
  jsonb_set(:'publish_draft'::jsonb #> '{proposal,days}','{0,suggestions,0,clientId}',
    '"9ddddddd-dddd-4ddd-8ddd-dddddddddddd"'::jsonb))),
  'P0001','VALIDATION_FAILED','revision rejects client outside seller portfolio');
select throws_ok(format($sql$select api.revise_weekly_route_proposal(%L::uuid,%L::jsonb)$sql$,
  :'publish_draft'::jsonb ->> 'proposalId',jsonb_build_object('schemaVersion',1,
  'idempotencyKey','9eeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','expectedVersion',1,'days',
  jsonb_set(:'publish_draft'::jsonb #> '{proposal,days}','{0,suggestions}',
    (select jsonb_agg(jsonb_set(:'publish_draft'::jsonb #> '{proposal,days,0,suggestions,0}',
      '{plannedOrder}',to_jsonb(value))) from generate_series(1,11) value)))),
  'P0001','VALIDATION_FAILED','revision cannot exceed ten clients in a day');
select api.decide_weekly_route_proposal((:'publish_draft'::jsonb ->> 'proposalId')::uuid,jsonb_build_object(
  'schemaVersion',1,'idempotencyKey','99999999-9999-4999-8999-999999999999','expectedVersion',1,
  'decision','publish','reason',null)) as published \gset
select is(:'published'::jsonb ->> 'status','published','explicit decision publishes proposal');
select is(jsonb_array_length(:'published'::jsonb -> 'routeIds'),1,'only non-empty day creates a route');
reset role;
select is((select count(*)::integer from api.routes where seller_id=:'seller_id' and service_date='2026-11-16'),1,
  'published proposal creates exactly one canonical route');

set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_id', true);
select api.revise_weekly_route_proposal((:'published'::jsonb ->> 'proposalId')::uuid,jsonb_build_object(
  'schemaVersion',1,'idempotencyKey','9aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','expectedVersion',1,
  'days',:'published'::jsonb #> '{proposal,days}')) as successor \gset
select is(:'successor'::jsonb ->> 'status','draft','editing published proposal creates a new draft');
select isnt(:'successor'::jsonb ->> 'proposalId',:'published'::jsonb ->> 'proposalId','published version remains immutable');
select is(api.revise_weekly_route_proposal((:'published'::jsonb ->> 'proposalId')::uuid,jsonb_build_object(
  'schemaVersion',1,'idempotencyKey','9aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','expectedVersion',1,
  'days',:'published'::jsonb #> '{proposal,days}')) ->> 'proposalId',:'successor'::jsonb ->> 'proposalId',
  'successor revision replays idempotently from original proposal id');
select is((api.decide_weekly_route_proposal((:'successor'::jsonb ->> 'proposalId')::uuid,jsonb_build_object(
  'schemaVersion',1,'idempotencyKey','9bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','expectedVersion',2,
  'decision','publish','reason',null)) ->> 'status'),'published','successor republishes over canonical route revision');
select api.revise_weekly_route_proposal((:'successor'::jsonb ->> 'proposalId')::uuid,jsonb_build_object(
  'schemaVersion',1,'idempotencyKey','91212121-1212-4121-8121-121212121212','expectedVersion',2,
  'days',(select jsonb_agg(jsonb_set(day,'{suggestions}','[]'::jsonb) order by (day ->> 'dayIndex')::integer)
    from jsonb_array_elements(:'successor'::jsonb #> '{proposal,days}') day))) as empty_successor \gset
select is(:'empty_successor'::jsonb #>> '{proposal,counts,suggested}','0','empty revision recomputes suggested count');
select is((api.decide_weekly_route_proposal((:'empty_successor'::jsonb ->> 'proposalId')::uuid,jsonb_build_object(
  'schemaVersion',1,'idempotencyKey','91313131-1313-4131-8131-131313131313','expectedVersion',3,
  'decision','publish','reason',null)) ->> 'status'),'published','empty successor publishes explicit cancellation');
reset role;
select is((select status from api.routes where seller_id=:'seller_id' and service_date='2026-11-16'),'cancelled',
  'empty approved day cancels the former canonical route');

select jsonb_set(jsonb_set(:'save_command'::jsonb,'{idempotencyKey}',
  '"9fffffff-ffff-4fff-8fff-ffffffffffff"'::jsonb),'{proposal}',
  jsonb_set(jsonb_set(:'save_command'::jsonb -> 'proposal','{weekStart}','"2026-11-23"'::jsonb),'{days}',
    (select jsonb_agg(jsonb_set(day,'{serviceDate}',to_jsonb(('2026-11-23'::date + (day ->> 'dayIndex')::integer)::text))
      order by (day ->> 'dayIndex')::integer) from jsonb_array_elements(:'save_command'::jsonb #> '{proposal,days}') day))) as offboard_command \gset
set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_id', true);
select api.save_weekly_route_proposal(:'offboard_command'::jsonb) as offboard_draft \gset
select is(:'offboard_draft'::jsonb ->> 'status','draft','proposal can be drafted before offboarding');
reset role;
set local role cirne_administration_executor;
update api.seller_route_profiles set offboarding_at='2026-11-05T00:00:00Z',version=version+1 where seller_id=:'seller_id';
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', :'manager_id', true);
select throws_ok(format($sql$select api.decide_weekly_route_proposal(%L::uuid,%L::jsonb)$sql$,
  :'offboard_draft'::jsonb ->> 'proposalId',jsonb_build_object('schemaVersion',1,
  'idempotencyKey','90000000-0000-4000-8000-000000000009','expectedVersion',1,
  'decision','publish','reason',null)),'P0001','FORBIDDEN','approval revalidates effective offboarding');
reset role;

do $test_roles$
begin
  execute pg_catalog.format('revoke cirne_administration_executor from %I granted by current_user',current_user);
  execute pg_catalog.format('revoke service_role from %I granted by current_user',current_user);
end
$test_roles$;

select * from finish();
rollback;
