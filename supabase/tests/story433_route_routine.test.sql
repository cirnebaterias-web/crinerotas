begin;
select no_plan();
do $roles$
begin
  execute pg_catalog.format('grant cirne_route_executor,cirne_administration_executor,cirne_visit_executor to %I with inherit true,set true granted by current_user',current_user);
end $roles$;

select has_function('api','list_seller_client_visit_coverage',array['uuid'],'coverage has a batch RPC');
select has_function('api','get_active_weekly_route_proposal',array['uuid','date'],'seller/week lookup exists');
select has_function('api','regenerate_weekly_route_proposal',array['uuid','jsonb'],'regenerate RPC exists');
select has_function('api','get_weekly_route_proposal_mutation_replay',array['jsonb'],'mutation replay reader exists');
select ok(not has_function_privilege('anon','api.list_seller_client_visit_coverage(uuid)','EXECUTE'),'anonymous coverage is denied');
select ok(not has_function_privilege('anon','api.get_weekly_route_proposal_mutation_replay(jsonb)','EXECUTE'),'anonymous mutation replay is denied');
select ok(not has_function_privilege('service_role','api.get_weekly_route_proposal_mutation_replay(jsonb)','EXECUTE'),'service role cannot bypass replay authorization');
select ok(not has_table_privilege('authenticated','api.visits','SELECT'),'visit rows remain private');
select ok(not has_function_privilege('authenticated','private.regenerate_weekly_route_proposal(uuid,jsonb)','EXECUTE'),'private mutation is not exposed');

select id as seller_id from auth.users where raw_user_meta_data ->> 'actorKey'='seller_a' \gset
select id as other_seller_id from auth.users where raw_user_meta_data ->> 'actorKey'='seller_b' \gset
select id as manager_id from auth.users where raw_user_meta_data ->> 'actorKey'='manager_a' \gset
select id as administrator_id from auth.users where raw_user_meta_data ->> 'actorKey'='administrator' \gset

insert into api.clients(id,external_reference,name,address,status)
values('43300000-0000-4000-8000-000000000001','43300000000001','Cliente cobertura','Rua visitavel','active'),
  ('43300000-0000-4000-8000-000000000002','43300000000002','Sem visita','Rua visitavel','active'),
  ('43300000-0000-4000-8000-000000000003','43300000000003','Outra carteira','Rua visitavel','active');
insert into api.client_seller_scopes(client_id,seller_id,assigned_by) values
  ('43300000-0000-4000-8000-000000000001',:'seller_id',:'manager_id'),
  ('43300000-0000-4000-8000-000000000002',:'seller_id',:'manager_id'),
  ('43300000-0000-4000-8000-000000000003',:'other_seller_id',:'manager_id');
insert into api.seller_route_profiles(seller_id,base_city,base_state,base_ibge_code,base_latitude,base_longitude,updated_by)
values(:'seller_id','Natal','RN','2408102',-5.83,-35.21,:'manager_id');
insert into private.sales_sources(source_key) values(repeat('3',64));
insert into private.sales_sync_runs(id,source_key,request_key,trigger,requested_by,lease_expires_at,status,
  content_hash,parser_version,source_row_count,staged_row_count,completed_at)
values('43300000-0000-4000-8000-000000000030',repeat('3',64),'story433','manual',:'manager_id',
  now(),'published',repeat('a',64),1,1,1,now());
update private.sales_sources set published_run_id='43300000-0000-4000-8000-000000000030';
insert into private.sales_snapshot_lines(run_id,source_row,external_key,client_external_reference,invoice_number,sale_date,
  sku,product_description,item_group,item_subgroup,category,brand,line,kind,volume,total_amount,row_hash)
values('43300000-0000-4000-8000-000000000030',2,'story433','43300000000001','433','2099-09-30',
  '433','Bateria','Bateria','Bateria','Bateria','Marca','Linha','sale',1,100,repeat('c',64));

select jsonb_build_object('schemaVersion',1,'mode','rules','weekStart','2099-11-02','sellerId',:'seller_id',
  'generatedAt','2099-10-01T12:00:00Z',
  'policy',jsonb_build_object('version','weekly-route-rules-v3','inactiveAfterDays',180,'dailyClientLimit',10,
    'dailyGpsMaxAgeMinutes',5,'dailyGpsMaxAccuracyM',100,'coverageCadenceDays',28,'tripFromBaseDistanceKm',80,
    'weights',jsonb_build_object('recency',50,'volume',15,'scrapDebt',20,'proximity',15)),
  'origin',jsonb_build_object('kind','base_city','sellerId',:'seller_id','city','Natal','state','RN','ibgeCode','2408102',
    'configVersion',1,'latitude',-5.83,'longitude',-35.21,'reference','municipal_seat','source','IBGE'),
  'sources',jsonb_build_object('sales',jsonb_build_object('status','available','generationId','43300000-0000-4000-8000-000000000030','asOfDate','2099-10-01'),
    'scrap',jsonb_build_object('status','unavailable','generationId',null,'publishedAt',null),
    'visits',jsonb_build_object('status','available','asOfDate','2099-10-01')),
  'strategy',jsonb_build_object('kind','local','region','Natal','distanceFromBaseKm',0),
  'days',(select jsonb_agg(jsonb_build_object('dayIndex',i,'serviceDate',('2099-11-02'::date+i)::text,
    'suggestions','[]'::jsonb) order by i) from generate_series(0,4) i),
  'excluded',jsonb_build_array(),
  'counts',jsonb_build_object('evaluated',0,'suggested',0,'inactiveLost',0,'noPurchaseHistory',0,'needsReview',0,
    'coverageDue',0,'coveragePlanned',0,'coveragePending',0)) as proposal \gset

set local role authenticated;
select set_config('request.jwt.claim.sub',:'manager_id',true);
select api.save_weekly_route_proposal(jsonb_build_object('schemaVersion',1,
  'idempotencyKey','43300000-0000-4000-8000-000000000010','proposal',:'proposal'::jsonb)) as initial \gset
select is(api.get_active_weekly_route_proposal(:'seller_id','2099-11-02'),:'initial'::jsonb,'opening existing returns exact persisted state');
select is(api.get_active_weekly_route_proposal(:'seller_id','2099-11-02') ->> 'version','1','opening does not advance version');
select is(api.save_weekly_route_proposal(jsonb_build_object('schemaVersion',1,
  'idempotencyKey','43300000-0000-4000-8000-000000000010',
  'proposal',jsonb_set(jsonb_set(:'proposal'::jsonb,'{generatedAt}','"2099-10-01T15:00:00Z"'::jsonb),
    '{sources,visits}',jsonb_build_object('status','unavailable','asOfDate',null)))),:'initial'::jsonb,
  'save retry ignores the freshly generated timestamp and sources and returns the first committed response');
select throws_ok(format('select api.save_weekly_route_proposal(%L)',jsonb_build_object('schemaVersion',1,
  'idempotencyKey','43300000-0000-4000-8000-000000000010',
  'proposal',jsonb_set(:'proposal'::jsonb,'{sellerId}',to_jsonb(:'other_seller_id'::text)))),
  'P0001','IDEMPOTENCY_KEY_REUSED','save key cannot be reused for another seller');
select throws_ok(format('select api.save_weekly_route_proposal(%L)',jsonb_build_object('schemaVersion',1,
  'idempotencyKey','43300000-0000-4000-8000-000000000010',
  'proposal',jsonb_set(:'proposal'::jsonb,'{weekStart}','"2099-11-09"'::jsonb))),
  'P0001','IDEMPOTENCY_KEY_REUSED','save key cannot be reused for another week');
select jsonb_build_object('schemaVersion',1,'idempotencyKey','43300000-0000-4000-8000-000000000011',
  'expectedVersion',1,'proposal',jsonb_set(:'proposal'::jsonb,'{generatedAt}','"2099-10-01T13:00:00Z"'::jsonb)) as regeneration \gset
select jsonb_build_object('schemaVersion',1,'idempotencyKey','43300000-0000-4000-8000-000000000011',
  'operation','regenerate','targetId',:'initial'::jsonb ->> 'proposalId','expectedVersion',1,
  'sellerId',:'seller_id','weekStart','2099-11-02') as regeneration_intent \gset
select ok(api.get_weekly_route_proposal_mutation_replay(:'regeneration_intent'::jsonb) is null,
  'replay lookup returns null before the intent is committed');
select api.regenerate_weekly_route_proposal((:'initial'::jsonb ->> 'proposalId')::uuid,:'regeneration') as regenerated \gset
select is(:'regenerated'::jsonb ->> 'version','2','regeneration advances draft version');
select is(:'regenerated'::jsonb ->> 'proposalId',:'initial'::jsonb ->> 'proposalId','draft regeneration updates the existing aggregate');
select is(:'regenerated'::jsonb ->> 'predecessorVersion','1','draft predecessor version is recorded');
select is(api.regenerate_weekly_route_proposal((:'initial'::jsonb ->> 'proposalId')::uuid,:'regeneration'),
  :'regenerated'::jsonb,'lost response replay succeeds despite stale expectedVersion');
select is(api.get_weekly_route_proposal_mutation_replay(:'regeneration_intent'::jsonb),:'regenerated'::jsonb,
  'stable intent reads the original response before recalculating any source');
select is(api.get_weekly_route_proposal_mutation_replay(jsonb_build_object('schemaVersion',1,
  'idempotencyKey','43300000-0000-4000-8000-000000000010','operation','save','targetId',null,
  'expectedVersion',null,'sellerId',:'seller_id','weekStart','2099-11-02')),:'initial'::jsonb,
  'save intent reads its original response even after a later version exists');
select throws_ok(format('select api.get_weekly_route_proposal_mutation_replay(%L)',
  jsonb_set(:'regeneration_intent'::jsonb,'{expectedVersion}','2'::jsonb)),
  'P0001','IDEMPOTENCY_KEY_REUSED','replay lookup rejects an expected-version mismatch');
select throws_ok(format('select api.get_weekly_route_proposal_mutation_replay(%L)',
  jsonb_set(:'regeneration_intent'::jsonb,'{sellerId}',to_jsonb(:'other_seller_id'::text))),
  'P0001','IDEMPOTENCY_KEY_REUSED','replay lookup rejects another seller context');
select throws_ok(format('select api.get_weekly_route_proposal_mutation_replay(%L)',
  jsonb_set(:'regeneration_intent'::jsonb,'{targetId}','"43300000-0000-4000-8000-000000000099"'::jsonb)),
  'P0001','IDEMPOTENCY_KEY_REUSED','replay lookup rejects another target context');
select throws_ok(format('select api.get_weekly_route_proposal_mutation_replay(%L)',
  jsonb_set(:'regeneration_intent'::jsonb,'{weekStart}','"2099-11-09"'::jsonb)),
  'P0001','IDEMPOTENCY_KEY_REUSED','replay lookup rejects another week context');
select throws_ok(format('select api.get_weekly_route_proposal_mutation_replay(%L)',
  jsonb_set(:'regeneration_intent'::jsonb,'{operation}','"revise"'::jsonb)),
  'P0001','IDEMPOTENCY_KEY_REUSED','replay lookup rejects another operation context');
select is(api.regenerate_weekly_route_proposal((:'initial'::jsonb ->> 'proposalId')::uuid,
  jsonb_set(jsonb_set(:'regeneration'::jsonb,'{proposal,generatedAt}','"2099-10-01T14:00:00Z"'::jsonb),
    '{proposal,sources}',jsonb_build_object('sales',jsonb_build_object('status','unavailable','generationId',null,'asOfDate',null),
      'scrap',jsonb_build_object('status','unavailable','generationId',null,'publishedAt',null),
      'visits',jsonb_build_object('status','unavailable','asOfDate',null)))),
  :'regenerated'::jsonb,'retry with freshly generated timestamp and sources replays the original snapshot');
select is(api.get_weekly_route_proposal((:'initial'::jsonb ->> 'proposalId')::uuid),:'regenerated'::jsonb,
  'retry does not replace persisted content with its newly generated snapshot');
select throws_ok(format('select api.regenerate_weekly_route_proposal(%L,%L)',:'initial'::jsonb ->> 'proposalId',
  jsonb_set(:'regeneration'::jsonb,'{expectedVersion}','2'::jsonb)),
  'P0001','IDEMPOTENCY_KEY_REUSED','another expected version cannot reuse the transition key');
select throws_ok(format('select api.regenerate_weekly_route_proposal(%L,%L)',
  '43300000-0000-4000-8000-000000000099',:'regeneration'::jsonb),
  'P0001','IDEMPOTENCY_KEY_REUSED','another target cannot reuse the transition key');
select throws_ok(format('select api.regenerate_weekly_route_proposal(%L,%L)',:'initial'::jsonb ->> 'proposalId',
  jsonb_set(:'regeneration'::jsonb,'{proposal,sellerId}',to_jsonb(:'other_seller_id'::text))),
  'P0001','IDEMPOTENCY_KEY_REUSED','another seller cannot reuse the transition key');
select throws_ok(format('select api.regenerate_weekly_route_proposal(%L,%L)',:'initial'::jsonb ->> 'proposalId',
  jsonb_set(:'regeneration'::jsonb,'{proposal,weekStart}','"2099-11-09"'::jsonb)),
  'P0001','IDEMPOTENCY_KEY_REUSED','another week cannot reuse the transition key');
select throws_ok(format('select api.regenerate_weekly_route_proposal(%L,%L)',:'initial'::jsonb ->> 'proposalId',
  jsonb_set(:'regeneration'::jsonb,'{proposal,schemaVersion}','2'::jsonb)),
  'P0001','IDEMPOTENCY_KEY_REUSED','another proposal schema cannot reuse the transition key');
select throws_ok(format('select api.regenerate_weekly_route_proposal(%L,%L)',:'initial'::jsonb ->> 'proposalId',
  jsonb_set(:'regeneration'::jsonb,'{idempotencyKey}','"43300000-0000-4000-8000-000000000012"'::jsonb)),
  'P0001','VERSION_CONFLICT','another generation with a stale version conflicts');
reset role;
select is((select count(*)::integer from private.audit_events where action='weekly_route_proposal.regenerated'
  and target_id=(:'initial'::jsonb ->> 'proposalId')::uuid),1,'replay produces no extra audit event');
select ok((select before_data ->> 'version'='1' and after_data ->> 'version'='2'
  from private.audit_events where action='weekly_route_proposal.regenerated'
  and target_id=(:'initial'::jsonb ->> 'proposalId')::uuid),'regeneration audits full before and after');

-- Publish a real route, regenerate, and prove the seller keeps the old route.
select jsonb_set(jsonb_set(:'proposal'::jsonb,'{days,0,suggestions}',jsonb_build_array(jsonb_build_object(
  'clientId','43300000-0000-4000-8000-000000000001','name','Cliente cobertura','dayIndex',0,'plannedOrder',1,
  'score',80,'approximateDistanceKm',null,'reasons',jsonb_build_array('Visita inicial'),
  'scrapBalanceState','unavailable','locationPending',true,'lastCompletedVisitAt',null,
  'coverageState','never_visited','coverageOverdueDays',null,'nextVisitDueOn',null))),'{counts}',
  jsonb_build_object('evaluated',1,'suggested',1,'inactiveLost',0,'noPurchaseHistory',0,'needsReview',0,
    'coverageDue',1,'coveragePlanned',1,'coveragePending',0)) as populated \gset
set local role authenticated;
select set_config('request.jwt.claim.sub',:'manager_id',true);
select throws_ok(format('select api.regenerate_weekly_route_proposal(%L,%L)',:'initial'::jsonb ->> 'proposalId',
  jsonb_build_object('schemaVersion',1,'idempotencyKey','43300000-0000-4000-8000-000000000031','expectedVersion',2,
    'proposal',jsonb_set(:'populated'::jsonb,'{sources,sales,status}','"unavailable"'::jsonb))),
  'P0001','VALIDATION_FAILED','payload cannot schedule clients without confirmed sales eligibility');
select throws_ok(format('select api.regenerate_weekly_route_proposal(%L,%L)',:'initial'::jsonb ->> 'proposalId',
  jsonb_build_object('schemaVersion',1,'idempotencyKey','43300000-0000-4000-8000-000000000032','expectedVersion',2,
    'proposal',jsonb_set(:'populated'::jsonb,'{days,0,suggestions,0,coverageState}','"covered"'::jsonb))),
  'P0001','VALIDATION_FAILED','payload cannot claim a never-visited customer is covered');
select api.regenerate_weekly_route_proposal((:'initial'::jsonb ->> 'proposalId')::uuid,jsonb_build_object(
  'schemaVersion',1,'idempotencyKey','43300000-0000-4000-8000-000000000013','expectedVersion',2,
  'proposal',:'populated'::jsonb)) as populated_draft \gset
select api.decide_weekly_route_proposal((:'initial'::jsonb ->> 'proposalId')::uuid,jsonb_build_object(
  'schemaVersion',1,'idempotencyKey','43300000-0000-4000-8000-000000000014','expectedVersion',3,
  'decision','publish','reason',null)) as publication \gset
select is(jsonb_array_length(:'publication'::jsonb -> 'routeIds'),1,'approval publishes one canonical route');
select jsonb_build_object('schemaVersion',1,'idempotencyKey','43300000-0000-4000-8000-000000000015',
  'expectedVersion',3,'proposal',:'populated'::jsonb) as successor_command \gset
select api.regenerate_weekly_route_proposal((:'publication'::jsonb ->> 'proposalId')::uuid,:'successor_command') as successor \gset
select isnt(:'successor'::jsonb ->> 'proposalId',:'publication'::jsonb ->> 'proposalId','published regeneration creates successor');
select is(:'successor'::jsonb ->> 'version','4','successor version continues lineage');
select is(:'successor'::jsonb ->> 'status','draft','successor requires a fresh approval');
select is(api.get_weekly_route_proposal((:'publication'::jsonb ->> 'proposalId')::uuid),:'publication'::jsonb,
  'published proposal is untouched until successor approval');
select is(api.get_active_weekly_route_proposal(:'seller_id','2099-11-02') ->> 'proposalId',
  :'successor'::jsonb ->> 'proposalId','open selects the pending successor');
select is(api.regenerate_weekly_route_proposal((:'publication'::jsonb ->> 'proposalId')::uuid,:'successor_command'),
  :'successor'::jsonb,'successor replay returns the original result before current-state conflict');
select throws_ok(format('select api.regenerate_weekly_route_proposal(%L,%L)',:'publication'::jsonb ->> 'proposalId',
  jsonb_set(:'successor_command'::jsonb,'{idempotencyKey}','"43300000-0000-4000-8000-000000000016"'::jsonb)),
  'P0001','VERSION_CONFLICT','a second successor cannot duplicate the same published version');
reset role;
select is((select status from api.routes where id=(:'publication'::jsonb #>> '{routeIds,0}')::uuid),
  'published','canonical route stays published during regeneration');
select is((select count(*)::integer from api.routes where seller_id=:'seller_id' and service_date='2099-11-02'),1,
  'regeneration does not duplicate routes');

-- An in-progress visit is ignored. Only server-confirmed completion pays coverage.
update api.parameter_sets set status='retired' where status='published';
insert into api.parameter_sets(id,version,status,valid_from,published_at,published_by)
values('43300000-0000-4000-8000-000000000020',433,'published','2099-01-01','2099-01-01',:'administrator_id');
insert into api.visits(id,offline_id,device_id,route_version_stop_id,route_version_id,client_id,seller_id,
  parameter_set_id,status,context_snapshot,start_payload_hash,device_started_at,server_started_at)
select '43300000-0000-4000-8000-000000000021','43300000-0000-4000-8000-000000000022',
  '43300000-0000-4000-8000-000000000023',stop.id,stop.route_version_id,stop.client_id,:'seller_id',
  '43300000-0000-4000-8000-000000000020','in_progress','{}'::jsonb,repeat('a',64),'2099-11-02T12:00:00Z','2099-11-02T12:00:01Z'
from api.route_version_stops stop join api.route_versions version on version.id=stop.route_version_id
where version.route_id=(:'publication'::jsonb #>> '{routeIds,0}')::uuid;
set local role authenticated;
select set_config('request.jwt.claim.sub',:'manager_id',true);
select api.list_seller_client_visit_coverage(:'seller_id') as before_coverage \gset
select ok((select value -> 'lastCompletedVisitAt'='null'::jsonb from jsonb_array_elements(:'before_coverage'::jsonb -> 'clients')
  where value ->> 'clientId'='43300000-0000-4000-8000-000000000001'),'starting a visit does not pay coverage');
select ok(not exists(select 1 from jsonb_array_elements(:'before_coverage'::jsonb -> 'clients')
  where value ->> 'clientId'='43300000-0000-4000-8000-000000000003'),'batch coverage excludes other portfolios');
select throws_ok(format('select api.list_seller_client_visit_coverage(%L)',:'other_seller_id'),
  'P0001','NOT_FOUND','manager cannot query another seller coverage');
reset role;
insert into api.visits(id,offline_id,device_id,route_version_stop_id,route_version_id,client_id,seller_id,
  parameter_set_id,status,context_snapshot,start_payload_hash,device_started_at,server_started_at,
  device_completed_at,server_completed_at,completion_payload_hash)
select '43300000-0000-4000-8000-000000000026','43300000-0000-4000-8000-000000000027',device_id,
  route_version_stop_id,route_version_id,client_id,seller_id,parameter_set_id,'completed',context_snapshot,
  start_payload_hash,device_started_at,server_started_at,'2099-11-02T13:00:00Z','2099-11-02T13:00:01Z',repeat('b',64)
from api.visits where id='43300000-0000-4000-8000-000000000021';
set local role authenticated;
select set_config('request.jwt.claim.sub',:'manager_id',true);
select api.list_seller_client_visit_coverage(:'seller_id') as coverage \gset
select is((select (value ->> 'lastCompletedVisitAt')::timestamptz from jsonb_array_elements(:'coverage'::jsonb -> 'clients')
  where value ->> 'clientId'='43300000-0000-4000-8000-000000000001'),
  '2099-11-02T13:00:01Z'::timestamptz,'coverage uses confirmed server completion');
select ok((select value -> 'lastCompletedVisitAt'='null'::jsonb from jsonb_array_elements(:'coverage'::jsonb -> 'clients')
  where value ->> 'clientId'='43300000-0000-4000-8000-000000000002'),'absence stays explicit for a client with no visit');
select is((api.decide_weekly_route_proposal((:'successor'::jsonb ->> 'proposalId')::uuid,jsonb_build_object(
  'schemaVersion',1,'idempotencyKey','43300000-0000-4000-8000-000000000025','expectedVersion',4,
  'decision','publish','reason',null)) ->> 'status'),'published','successor approval succeeds atomically');
select is(api.get_weekly_route_proposal((:'publication'::jsonb ->> 'proposalId')::uuid) ->> 'status',
  'superseded','previous publication is superseded only after approval');
select api.revise_weekly_route_proposal((:'successor'::jsonb ->> 'proposalId')::uuid,jsonb_build_object(
  'schemaVersion',1,'idempotencyKey','43300000-0000-4000-8000-000000000033','expectedVersion',4,
  'days',(select jsonb_agg(jsonb_set(day,'{suggestions}','[]'::jsonb) order by (day ->> 'dayIndex')::integer)
    from jsonb_array_elements(:'populated'::jsonb -> 'days') day))) as empty_draft \gset
select is(:'empty_draft'::jsonb #>> '{proposal,counts,coveragePlanned}','0','manual revision recomputes planned coverage');
select is(:'empty_draft'::jsonb #>> '{proposal,counts,coveragePending}','1','manual removal restores coverage debt');
select is(api.get_weekly_route_proposal((:'successor'::jsonb ->> 'proposalId')::uuid) ->> 'status',
  'published','manual successor revision also preserves the current publication');
select throws_ok(format('select api.revise_weekly_route_proposal(%L,%L)',:'empty_draft'::jsonb ->> 'proposalId',
  jsonb_build_object('schemaVersion',1,'idempotencyKey','43300000-0000-4000-8000-000000000034','expectedVersion',5,
    'days',jsonb_set(:'populated'::jsonb -> 'days','{0,suggestions,0,coverageState}','"unavailable"'::jsonb))),
  'P0001','VALIDATION_FAILED','manual addition cannot claim coverage unavailable against an available visit source');
select api.revise_weekly_route_proposal((:'empty_draft'::jsonb ->> 'proposalId')::uuid,jsonb_build_object(
  'schemaVersion',1,'idempotencyKey','43300000-0000-4000-8000-000000000035','expectedVersion',5,
  'days',:'populated'::jsonb -> 'days')) as manual_addition \gset
select is(:'manual_addition'::jsonb #>> '{proposal,days,0,suggestions,0,coverageState}','never_visited',
  'manual addition persists the actual coverage state from the proposal reference snapshot');
select is(:'manual_addition'::jsonb #>> '{proposal,counts,coveragePlanned}','1',
  'manual addition updates planned coverage canonically');
select is(:'manual_addition'::jsonb #>> '{proposal,counts,coveragePending}','0',
  'manual addition updates pending coverage canonically');
reset role;

update api.user_seller_scopes set revoked_at=statement_timestamp()
where manager_user_id=:'manager_id' and seller_user_id=:'seller_id' and revoked_at is null;
set local role authenticated;
select set_config('request.jwt.claim.sub',:'manager_id',true);
select throws_ok(format('select api.regenerate_weekly_route_proposal(%L,%L)',
  :'initial'::jsonb ->> 'proposalId',:'regeneration'::jsonb),'P0001','NOT_FOUND',
  'replay still revalidates current seller authorization');
select throws_ok(format('select api.get_active_weekly_route_proposal(%L,%L)',:'seller_id','2099-11-02'),
  'P0001','NOT_FOUND','active lookup conceals proposals after scope revocation');
select throws_ok(format('select api.get_weekly_route_proposal_mutation_replay(%L)',:'regeneration_intent'::jsonb),
  'P0001','NOT_FOUND','replay reader revalidates current seller authorization');
reset role;

select * from finish();
rollback;
