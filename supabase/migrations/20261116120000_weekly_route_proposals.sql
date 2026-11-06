begin;

do $preflight$
begin
  if to_regprocedure('private.create_route_draft(jsonb)') is null
     or to_regprocedure('private.publish_route(uuid,integer)') is null
     or to_regprocedure('private.route_identity(text)') is null then
    raise exception 'Weekly route proposals require the route foundation';
  end if;
  if to_regclass('api.weekly_route_proposals') is not null then
    raise exception 'Weekly route proposals already exist';
  end if;
end
$preflight$;

do $ownership$
begin
  execute pg_catalog.format('grant cirne_route_executor to %I with set true granted by current_user', current_user);
end
$ownership$;
grant create on schema api, private to cirne_route_executor;
grant references on table api.user_profiles to cirne_route_executor;
do $profile_ownership$
begin execute pg_catalog.format('grant cirne_administration_executor to %I with set true granted by current_user',current_user); end
$profile_ownership$;
set local role cirne_administration_executor;
grant execute on function private.seller_route_profile_document(uuid,timestamptz) to cirne_route_executor;
reset role;
do $profile_ownership$
begin execute pg_catalog.format('revoke cirne_administration_executor from %I granted by current_user',current_user); end
$profile_ownership$;
set local role cirne_route_executor;

create table api.weekly_route_proposals (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references api.user_profiles(id) on delete restrict,
  week_start date not null check (extract(isodow from week_start) = 1),
  version integer not null default 1 check (version > 0),
  status text not null default 'draft'
    check (status in ('draft', 'published', 'rejected', 'superseded')),
  proposal jsonb not null,
  source_policy_version text not null,
  created_by uuid not null references api.user_profiles(id) on delete restrict,
  published_by uuid references api.user_profiles(id) on delete restrict,
  published_at timestamptz,
  route_ids uuid[] not null default array[]::uuid[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint weekly_route_proposal_publication_check check (
    (status in ('published','superseded') and published_by is not null and published_at is not null)
    or (status in ('draft','rejected') and published_by is null and published_at is null)
  ),
  constraint weekly_route_proposal_document_check check (
    jsonb_typeof(proposal) = 'object'
    and proposal ->> 'schemaVersion' = '1'
    and proposal ->> 'sellerId' = seller_id::text
    and proposal ->> 'weekStart' = to_char(week_start, 'YYYY-MM-DD')
    and jsonb_typeof(proposal -> 'days') = 'array'
    and jsonb_array_length(proposal -> 'days') = 5
  ),
  constraint weekly_route_proposal_route_count_check check (cardinality(route_ids) <= 5)
);

create unique index weekly_route_proposals_active_key
  on api.weekly_route_proposals(seller_id, week_start)
  where status in ('draft', 'published');
create index weekly_route_proposals_lookup
  on api.weekly_route_proposals(week_start desc, seller_id, created_at desc);

create table private.weekly_route_proposal_commands (
  actor_id uuid not null,
  idempotency_key uuid not null,
  operation text not null check (operation in ('save', 'revise', 'publish', 'reject', 'capture_location')),
  target_id uuid not null,
  command jsonb not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key(actor_id, idempotency_key)
);

create table api.seller_daily_route_locations (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references api.user_profiles(id) on delete restrict,
  service_date date not null,
  version integer not null check (version > 0),
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  accuracy_m double precision not null check (accuracy_m between 0 and 10000),
  captured_at timestamptz not null,
  captured_by uuid not null references api.user_profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique(seller_id, service_date, version)
);
create index seller_daily_route_locations_latest
  on api.seller_daily_route_locations(seller_id, service_date, version desc);

alter table api.weekly_route_proposals enable row level security;
alter table api.weekly_route_proposals force row level security;
alter table api.seller_daily_route_locations enable row level security;
alter table api.seller_daily_route_locations force row level security;
alter table private.weekly_route_proposal_commands enable row level security;
alter table private.weekly_route_proposal_commands force row level security;
create policy weekly_route_proposals_executor on api.weekly_route_proposals
  for all to cirne_route_executor using (true) with check (true);
create policy seller_daily_route_locations_executor on api.seller_daily_route_locations
  for all to cirne_route_executor using (true) with check (true);
create policy weekly_route_proposal_commands_executor on private.weekly_route_proposal_commands
  for all to cirne_route_executor using (true) with check (true);

create function private.weekly_route_proposal_document(p_id uuid)
returns jsonb language sql stable security definer set search_path = ''
as $function$
  select jsonb_build_object(
    'schemaVersion', 1, 'proposalId', row.id, 'version', row.version,
    'status', row.status, 'proposal', row.proposal, 'createdBy', row.created_by,
    'createdAt', row.created_at, 'updatedAt', row.updated_at,
    'publishedBy', row.published_by, 'publishedAt', row.published_at,
    'routeIds', to_jsonb(row.route_ids)
  ) from api.weekly_route_proposals row where row.id = p_id;
$function$;

create function private.validate_weekly_route_proposal(p_seller uuid,p_week date,p_proposal jsonb)
returns void language plpgsql stable security definer set search_path=''
as $function$
declare client_count integer;
begin
  if p_proposal is null or jsonb_typeof(p_proposal) <> 'object'
     or (select count(*) from jsonb_object_keys(p_proposal)) <> 11
     or not p_proposal ?& array['schemaVersion','mode','weekStart','sellerId','generatedAt','policy','origin','sources','days','excluded','counts']
     or jsonb_typeof(p_proposal -> 'schemaVersion') is distinct from 'number'
     or (p_proposal ->> 'schemaVersion')::integer is distinct from 1
     or p_proposal ->> 'sellerId' is distinct from p_seller::text
     or p_proposal ->> 'weekStart' is distinct from to_char(p_week,'YYYY-MM-DD')
     or p_proposal ->> 'mode' is distinct from 'rules'
     or jsonb_typeof(p_proposal -> 'generatedAt') is distinct from 'string'
     or (p_proposal ->> 'generatedAt')::timestamptz is null
     or jsonb_typeof(p_proposal -> 'policy') is distinct from 'object'
     or (select count(*) from jsonb_object_keys(p_proposal -> 'policy')) <> 6
     or not (p_proposal -> 'policy') ?& array['version','inactiveAfterDays','dailyClientLimit','dailyGpsMaxAgeMinutes','dailyGpsMaxAccuracyM','weights']
     or p_proposal #>> '{policy,version}' is distinct from 'weekly-route-rules-v2'
     or jsonb_typeof(p_proposal #> '{policy,inactiveAfterDays}') is distinct from 'number'
     or (p_proposal #>> '{policy,inactiveAfterDays}')::integer is distinct from 180
     or jsonb_typeof(p_proposal #> '{policy,dailyClientLimit}') is distinct from 'number'
     or (p_proposal #>> '{policy,dailyClientLimit}')::integer is distinct from 10
     or jsonb_typeof(p_proposal #> '{policy,dailyGpsMaxAgeMinutes}') is distinct from 'number'
     or (p_proposal #>> '{policy,dailyGpsMaxAgeMinutes}')::integer is distinct from 5
     or jsonb_typeof(p_proposal #> '{policy,dailyGpsMaxAccuracyM}') is distinct from 'number'
     or (p_proposal #>> '{policy,dailyGpsMaxAccuracyM}')::integer is distinct from 100
     or jsonb_typeof(p_proposal #> '{policy,weights}') is distinct from 'object'
     or (select count(*) from jsonb_object_keys(p_proposal #> '{policy,weights}')) <> 4
     or not (p_proposal #> '{policy,weights}') ?& array['recency','volume','scrapDebt','proximity']
     or (p_proposal #>> '{policy,weights,recency}')::integer is distinct from 50
     or (p_proposal #>> '{policy,weights,volume}')::integer is distinct from 15
     or (p_proposal #>> '{policy,weights,scrapDebt}')::integer is distinct from 20
     or (p_proposal #>> '{policy,weights,proximity}')::integer is distinct from 15
     or p_proposal #>> '{origin,sellerId}' is distinct from p_seller::text
     or p_proposal #>> '{origin,kind}' is distinct from 'base_city'
     or jsonb_typeof(p_proposal -> 'origin') is distinct from 'object'
     or (select count(*) from jsonb_object_keys(p_proposal -> 'origin')) <> 10
     or not (p_proposal -> 'origin') ?& array['kind','sellerId','city','state','ibgeCode','configVersion','latitude','longitude','reference','source']
     or jsonb_typeof(p_proposal #> '{origin,city}') is distinct from 'string'
     or char_length(btrim(p_proposal #>> '{origin,city}')) is null
     or char_length(btrim(p_proposal #>> '{origin,city}')) not between 2 and 120
     or jsonb_typeof(p_proposal #> '{origin,state}') is distinct from 'string'
     or p_proposal #>> '{origin,state}' is null
     or p_proposal #>> '{origin,state}' !~ '^[A-Z]{2}$'
     or jsonb_typeof(p_proposal #> '{origin,ibgeCode}') is distinct from 'string'
     or p_proposal #>> '{origin,ibgeCode}' is null
     or p_proposal #>> '{origin,ibgeCode}' !~ '^[0-9]{7}$'
     or p_proposal #>> '{origin,reference}' is distinct from 'municipal_seat'
     or p_proposal #>> '{origin,source}' is distinct from 'IBGE'
     or jsonb_typeof(p_proposal #> '{origin,configVersion}') is distinct from 'number'
     or (p_proposal #>> '{origin,configVersion}')::integer is null
     or (p_proposal #>> '{origin,configVersion}')::numeric <> trunc((p_proposal #>> '{origin,configVersion}')::numeric)
     or (p_proposal #>> '{origin,configVersion}')::integer < 1
     or jsonb_typeof(p_proposal #> '{origin,latitude}') is distinct from 'number'
     or (p_proposal #>> '{origin,latitude}')::double precision is null
     or (p_proposal #>> '{origin,latitude}')::double precision not between -90 and 90
     or jsonb_typeof(p_proposal #> '{origin,longitude}') is distinct from 'number'
     or (p_proposal #>> '{origin,longitude}')::double precision is null
     or (p_proposal #>> '{origin,longitude}')::double precision not between -180 and 180
     or jsonb_typeof(p_proposal -> 'sources') is distinct from 'object'
     or (select count(*) from jsonb_object_keys(p_proposal -> 'sources')) <> 2
     or not (p_proposal -> 'sources') ?& array['sales','scrap']
     or jsonb_typeof(p_proposal #> '{sources,sales}') is distinct from 'object'
     or (select count(*) from jsonb_object_keys(p_proposal #> '{sources,sales}')) <> 3
     or not (p_proposal #> '{sources,sales}') ?& array['status','generationId','asOfDate']
     or jsonb_typeof(p_proposal #> '{sources,sales,generationId}') not in ('string','null')
     or jsonb_typeof(p_proposal #> '{sources,sales,generationId}') is null
     or jsonb_typeof(p_proposal #> '{sources,sales,asOfDate}') not in ('string','null')
     or jsonb_typeof(p_proposal #> '{sources,sales,asOfDate}') is null
     or jsonb_typeof(p_proposal #> '{sources,scrap}') is distinct from 'object'
     or (select count(*) from jsonb_object_keys(p_proposal #> '{sources,scrap}')) <> 3
     or not (p_proposal #> '{sources,scrap}') ?& array['status','generationId','publishedAt']
     or jsonb_typeof(p_proposal #> '{sources,scrap,generationId}') not in ('string','null')
     or jsonb_typeof(p_proposal #> '{sources,scrap,generationId}') is null
     or jsonb_typeof(p_proposal #> '{sources,scrap,publishedAt}') not in ('string','null')
     or jsonb_typeof(p_proposal #> '{sources,scrap,publishedAt}') is null
     or p_proposal #>> '{sources,sales,status}' is null
     or p_proposal #>> '{sources,sales,status}' not in ('available','unavailable')
     or p_proposal #>> '{sources,scrap,status}' is null
     or p_proposal #>> '{sources,scrap,status}' not in ('available','unavailable')
     or ((p_proposal #>> '{sources,sales,status}')='available' and
       ((p_proposal #>> '{sources,sales,generationId}')::uuid is null or (p_proposal #>> '{sources,sales,asOfDate}')::date is null))
     or ((p_proposal #>> '{sources,scrap,status}')='available' and
       ((p_proposal #>> '{sources,scrap,generationId}')::uuid is null or (p_proposal #>> '{sources,scrap,publishedAt}')::timestamptz is null))
     or jsonb_typeof(p_proposal -> 'days') is distinct from 'array'
     or jsonb_array_length(p_proposal -> 'days') <> 5
     or jsonb_typeof(p_proposal -> 'excluded') is distinct from 'array'
     or jsonb_typeof(p_proposal -> 'counts') is distinct from 'object'
     or (select count(*) from jsonb_object_keys(p_proposal -> 'counts')) <> 5
     or not (p_proposal -> 'counts') ?& array['evaluated','suggested','inactiveLost','noPurchaseHistory','needsReview']
     or (select count(distinct (day ->> 'dayIndex')::integer) from jsonb_array_elements(p_proposal -> 'days') day) <> 5
     or exists(select 1 from jsonb_array_elements(p_proposal -> 'days') day
       where jsonb_typeof(day) is distinct from 'object'
          or (select count(*) from jsonb_object_keys(day)) <> 3
          or not day ?& array['dayIndex','serviceDate','suggestions']
          or jsonb_typeof(day -> 'dayIndex') is distinct from 'number'
          or (day ->> 'dayIndex')::integer is null
          or (day ->> 'dayIndex')::numeric <> trunc((day ->> 'dayIndex')::numeric)
          or (day ->> 'dayIndex')::integer not between 0 and 4
          or (day ->> 'serviceDate')::date is distinct from p_week + (day ->> 'dayIndex')::integer
          or jsonb_typeof(day -> 'suggestions') is distinct from 'array'
          or jsonb_array_length(day -> 'suggestions') > 10
          or (select count(distinct (item ->> 'plannedOrder')::integer)
              from jsonb_array_elements(day -> 'suggestions') item) <> jsonb_array_length(day -> 'suggestions')
          or exists(select 1 from jsonb_array_elements(day -> 'suggestions') item
            where jsonb_typeof(item) is distinct from 'object'
               or (select count(*) from jsonb_object_keys(item)) <> 9
               or not item ?& array['clientId','name','dayIndex','plannedOrder','score','approximateDistanceKm','reasons','scrapBalanceState','locationPending']
               or jsonb_typeof(item -> 'plannedOrder') is distinct from 'number'
               or (item ->> 'plannedOrder')::integer is null
               or (item ->> 'plannedOrder')::numeric <> trunc((item ->> 'plannedOrder')::numeric)
               or (item ->> 'plannedOrder')::integer not between 1 and 10)) then
    raise exception using errcode='P0001',message='VALIDATION_FAILED';
  end if;
  if exists(select 1 from jsonb_array_elements(p_proposal -> 'days') day,
      jsonb_array_elements(day -> 'suggestions') item
      where jsonb_typeof(item -> 'dayIndex') is distinct from 'number'
         or (item ->> 'dayIndex')::numeric <> trunc((item ->> 'dayIndex')::numeric)
         or (item ->> 'dayIndex')::integer is distinct from (day ->> 'dayIndex')::integer
         or char_length(btrim(item ->> 'name')) is null
         or char_length(btrim(item ->> 'name')) not between 1 and 160
         or jsonb_typeof(item -> 'score') is distinct from 'number'
         or (item ->> 'score')::numeric is null
         or (item ->> 'score')::numeric < 0
         or jsonb_typeof(item -> 'approximateDistanceKm') is null
         or jsonb_typeof(item -> 'approximateDistanceKm') not in ('number','null')
         or (jsonb_typeof(item -> 'approximateDistanceKm')='number' and (item ->> 'approximateDistanceKm')::numeric < 0)
         or jsonb_typeof(item -> 'locationPending') is distinct from 'boolean'
         or jsonb_typeof(item -> 'reasons') is distinct from 'array'
         or jsonb_array_length(item -> 'reasons') not between 1 and 5
         or exists(select 1 from jsonb_array_elements(item -> 'reasons') reason
           where jsonb_typeof(reason) is distinct from 'string' or char_length(btrim(reason #>> '{}')) not between 1 and 180)
         or item ->> 'scrapBalanceState' is null
         or item ->> 'scrapBalanceState' not in ('debtor','creditor','settled','unavailable'))
     or exists(select 1 from jsonb_array_elements(p_proposal -> 'excluded') excluded
       where jsonb_typeof(excluded) is distinct from 'object'
          or (select count(*) from jsonb_object_keys(excluded)) <> 2
          or not excluded ?& array['clientId','reason']
          or excluded ->> 'reason' is null
          or excluded ->> 'reason' not in ('inactive_lost','no_purchase_history','client_not_active','no_navigable_location')
          or (excluded ->> 'clientId')::uuid is null)
     or jsonb_typeof(p_proposal #> '{counts,evaluated}') is distinct from 'number'
     or jsonb_typeof(p_proposal #> '{counts,suggested}') is distinct from 'number'
     or jsonb_typeof(p_proposal #> '{counts,inactiveLost}') is distinct from 'number'
     or jsonb_typeof(p_proposal #> '{counts,noPurchaseHistory}') is distinct from 'number'
     or jsonb_typeof(p_proposal #> '{counts,needsReview}') is distinct from 'number'
     or (p_proposal #>> '{counts,evaluated}')::numeric <> trunc((p_proposal #>> '{counts,evaluated}')::numeric)
     or (p_proposal #>> '{counts,suggested}')::numeric <> trunc((p_proposal #>> '{counts,suggested}')::numeric)
     or (p_proposal #>> '{counts,inactiveLost}')::numeric <> trunc((p_proposal #>> '{counts,inactiveLost}')::numeric)
     or (p_proposal #>> '{counts,noPurchaseHistory}')::numeric <> trunc((p_proposal #>> '{counts,noPurchaseHistory}')::numeric)
     or (p_proposal #>> '{counts,needsReview}')::numeric <> trunc((p_proposal #>> '{counts,needsReview}')::numeric)
     or (p_proposal #>> '{counts,evaluated}')::integer < 0
     or (p_proposal #>> '{counts,suggested}')::integer < 0
     or (p_proposal #>> '{counts,inactiveLost}')::integer < 0
     or (p_proposal #>> '{counts,noPurchaseHistory}')::integer < 0
     or (p_proposal #>> '{counts,needsReview}')::integer < 0
     or (p_proposal #>> '{counts,evaluated}')::integer < (p_proposal #>> '{counts,suggested}')::integer then
    raise exception using errcode='P0001',message='VALIDATION_FAILED';
  end if;
  select count(*) into client_count from (
    select (item ->> 'clientId')::uuid client_id
    from jsonb_array_elements(p_proposal -> 'days') day,
         jsonb_array_elements(day -> 'suggestions') item
  ) requested;
  if client_count <> (p_proposal #>> '{counts,suggested}')::integer
     or client_count <> (select count(distinct (item ->> 'clientId')::uuid)
      from jsonb_array_elements(p_proposal -> 'days') day,
           jsonb_array_elements(day -> 'suggestions') item)
     or client_count <> (select count(*) from api.client_seller_scopes scope
       join api.clients client on client.id=scope.client_id
       where scope.seller_id=p_seller and scope.revoked_at is null
         and client.status='active' and client.archived_at is null
         and scope.client_id in (select (item ->> 'clientId')::uuid
           from jsonb_array_elements(p_proposal -> 'days') day,
                jsonb_array_elements(day -> 'suggestions') item)) then
    raise exception using errcode='P0001',message='VALIDATION_FAILED';
  end if;
exception when invalid_text_representation or datetime_field_overflow or numeric_value_out_of_range then
  raise exception using errcode='P0001',message='VALIDATION_FAILED';
end
$function$;

create function private.save_weekly_route_proposal(p_command jsonb)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $function$
declare
  identity_document jsonb := private.route_identity('route.plan_scoped');
  actor uuid := (identity_document ->> 'id')::uuid;
  key uuid;
  seller uuid;
  week date;
  proposal jsonb;
  row api.weekly_route_proposals%rowtype;
  replay private.weekly_route_proposal_commands%rowtype;
  result jsonb;
begin
  if p_command is null or jsonb_typeof(p_command) <> 'object'
     or not (p_command ?& array['schemaVersion','idempotencyKey','proposal'])
     or p_command ->> 'schemaVersion' <> '1' then
    raise exception using errcode='P0001', message='VALIDATION_FAILED';
  end if;
  begin
    key := (p_command ->> 'idempotencyKey')::uuid;
    proposal := p_command -> 'proposal';
    seller := (proposal ->> 'sellerId')::uuid;
    week := (proposal ->> 'weekStart')::date;
  exception when others then
    raise exception using errcode='P0001', message='VALIDATION_FAILED';
  end;
  select * into replay from private.weekly_route_proposal_commands
    where actor_id=actor and idempotency_key=key;
  if found then
    if replay.operation <> 'save' or replay.command <> p_command then
      raise exception using errcode='P0001', message='VERSION_CONFLICT';
    end if;
    return replay.response;
  end if;
  if extract(isodow from week) <> 1
     or not exists (select 1 from jsonb_array_elements_text(identity_document -> 'scopeIds') scope where scope::uuid=seller)
     or jsonb_array_length(proposal -> 'days') <> 5 then
    raise exception using errcode='P0001', message='VALIDATION_FAILED';
  end if;
  perform private.validate_weekly_route_proposal(seller,week,proposal);
  if exists (select 1 from api.weekly_route_proposals where seller_id=seller and week_start=week and status in ('draft','published')) then
    raise exception using errcode='P0001', message='VERSION_CONFLICT';
  end if;
  insert into api.weekly_route_proposals(seller_id,week_start,proposal,source_policy_version,created_by)
  values(seller,week,proposal,proposal #>> '{policy,version}',actor) returning * into row;
  result := private.weekly_route_proposal_document(row.id);
  insert into private.weekly_route_proposal_commands values(actor,key,'save',row.id,p_command,result,now());
  insert into private.audit_events(actor_id,target_type,target_id,action,after_data,origin,request_id)
    values(actor,'weekly_route_proposal',row.id,'weekly_route_proposal.saved',result,'system',key);
  return result;
end
$function$;

create function private.revise_weekly_route_proposal(p_id uuid, p_command jsonb)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $function$
declare
  identity_document jsonb := private.route_identity('route.plan_scoped');
  actor uuid := (identity_document ->> 'id')::uuid;
  key uuid; expected integer; row api.weekly_route_proposals%rowtype;
  replay private.weekly_route_proposal_commands%rowtype; result jsonb; revised jsonb;
begin
  begin key := (p_command ->> 'idempotencyKey')::uuid; expected := (p_command ->> 'expectedVersion')::integer;
  exception when others then raise exception using errcode='P0001', message='VALIDATION_FAILED'; end;
  select * into replay from private.weekly_route_proposal_commands where actor_id=actor and idempotency_key=key;
  if found then
    if replay.operation <> 'revise' or replay.target_id <> p_id or replay.command <> p_command then
      raise exception using errcode='P0001', message='VERSION_CONFLICT'; end if;
    return replay.response;
  end if;
  select * into row from api.weekly_route_proposals where id=p_id for update;
  if not found or not exists (select 1 from jsonb_array_elements_text(identity_document -> 'scopeIds') scope where scope::uuid=row.seller_id) then
    raise exception using errcode='P0001', message='NOT_FOUND';
  end if;
  if row.status not in ('draft','published') or row.version <> expected or jsonb_array_length(p_command -> 'days') <> 5 then
    raise exception using errcode='P0001', message='VERSION_CONFLICT';
  end if;
  revised := jsonb_set(jsonb_set(row.proposal,'{days}',p_command -> 'days'),'{counts,suggested}',
    to_jsonb((select sum(jsonb_array_length(day -> 'suggestions'))::integer
      from jsonb_array_elements(p_command -> 'days') day)));
  perform private.validate_weekly_route_proposal(row.seller_id,row.week_start,revised);
  if row.status = 'published' then
    update api.weekly_route_proposals set status='superseded',updated_at=clock_timestamp() where id=p_id;
    insert into api.weekly_route_proposals(seller_id,week_start,version,status,proposal,source_policy_version,created_by)
      values(row.seller_id,row.week_start,row.version+1,'draft',revised,
        row.source_policy_version,actor) returning * into row;
  else
    update api.weekly_route_proposals set proposal=revised,
      version=version+1,updated_at=clock_timestamp() where id=p_id returning * into row;
  end if;
  result := private.weekly_route_proposal_document(row.id);
  insert into private.weekly_route_proposal_commands values(actor,key,'revise',p_id,p_command,result,now());
  insert into private.audit_events(actor_id,target_type,target_id,action,before_data,after_data,origin,request_id)
    values(actor,'weekly_route_proposal',row.id,'weekly_route_proposal.revised',
      jsonb_build_object('sourceProposalId',p_id,'version',expected),result,'system',key);
  return result;
end
$function$;

create function private.decide_weekly_route_proposal(p_id uuid, p_command jsonb)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $function$
declare
  identity_document jsonb := private.route_identity('route.plan_scoped');
  actor uuid := (identity_document ->> 'id')::uuid;
  key uuid; expected integer; decision text; reason text;
  row api.weekly_route_proposals%rowtype; day jsonb; draft jsonb; publication jsonb;
  routes uuid[] := array[]::uuid[]; replay private.weekly_route_proposal_commands%rowtype; result jsonb; profile jsonb;
begin
  begin key := (p_command ->> 'idempotencyKey')::uuid; expected := (p_command ->> 'expectedVersion')::integer;
  exception when others then raise exception using errcode='P0001', message='VALIDATION_FAILED'; end;
  decision := p_command ->> 'decision'; reason := nullif(btrim(p_command ->> 'reason'),'');
  if decision not in ('publish','reject') or (decision='reject' and reason is null) then
    raise exception using errcode='P0001', message='VALIDATION_FAILED'; end if;
  select * into replay from private.weekly_route_proposal_commands where actor_id=actor and idempotency_key=key;
  if found then
    if replay.operation <> decision or replay.target_id <> p_id or replay.command <> p_command then
      raise exception using errcode='P0001', message='VERSION_CONFLICT'; end if;
    return replay.response;
  end if;
  select * into row from api.weekly_route_proposals where id=p_id for update;
  if not found or not exists (select 1 from jsonb_array_elements_text(identity_document -> 'scopeIds') scope where scope::uuid=row.seller_id) then
    raise exception using errcode='P0001', message='NOT_FOUND'; end if;
  if row.status <> 'draft' or row.version <> expected then
    raise exception using errcode='P0001', message='VERSION_CONFLICT'; end if;
  if decision='publish' then
    profile := private.seller_route_profile_document(row.seller_id,clock_timestamp());
    if profile -> 'baseCity' = 'null'::jsonb or profile ->> 'lifecycle' = 'inactive'
       or profile ->> 'portfolioState' = 'unassigned'
       or profile #>> '{baseCity,city}' is distinct from row.proposal #>> '{origin,city}'
       or profile #>> '{baseCity,state}' is distinct from row.proposal #>> '{origin,state}'
       or profile #>> '{baseCity,ibgeCode}' is distinct from row.proposal #>> '{origin,ibgeCode}'
       or (profile ->> 'version')::integer is distinct from (row.proposal #>> '{origin,configVersion}')::integer
       or not exists(select 1 from api.client_seller_scopes scope
        where scope.seller_id=row.seller_id and scope.revoked_at is null) then
      raise exception using errcode='P0001',message='FORBIDDEN';
    end if;
    perform private.validate_weekly_route_proposal(row.seller_id,row.week_start,row.proposal);
    for day in select value from jsonb_array_elements(row.proposal -> 'days') loop
      if jsonb_array_length(day -> 'suggestions') > 0 then
        select jsonb_agg(jsonb_build_object('clientId',item ->> 'clientId',
          'plannedOrder',(item ->> 'plannedOrder')::integer,'priority',least(9,greatest(0,round((item ->> 'score')::numeric / 10)::integer)))
          order by (item ->> 'plannedOrder')::integer) into publication
          from jsonb_array_elements(day -> 'suggestions') item;
        select jsonb_build_object('routeId',route.id,'status',route.status,'expectedVersion',route.lock_version)
          into draft from api.routes route where route.seller_id=row.seller_id
          and route.service_date=(day ->> 'serviceDate')::date for update;
        if draft is null then
          draft := private.create_route_draft(jsonb_build_object('schemaVersion',1,'serviceDate',day ->> 'serviceDate',
            'sellerId',row.seller_id,'stops',publication));
        elsif draft ->> 'status' = 'published' then
          draft := private.change_route_composition((draft ->> 'routeId')::uuid,
            jsonb_build_object('schemaVersion',1,'expectedVersion',(draft ->> 'expectedVersion')::integer,
              'reason','Nova versão da proposta semanal '||row.version,'stops',publication),gen_random_uuid(),'web');
        else
          raise exception using errcode='P0001',message='VERSION_CONFLICT';
        end if;
        publication := private.publish_route((draft ->> 'routeId')::uuid,(draft ->> 'expectedVersion')::integer);
        routes := array_append(routes,(publication ->> 'routeId')::uuid);
      else
        select jsonb_build_object('routeId',route.id,'status',route.status,'expectedVersion',route.lock_version)
          into draft from api.routes route where route.seller_id=row.seller_id
          and route.service_date=(day ->> 'serviceDate')::date for update;
        if draft is not null then
          if draft ->> 'status' <> 'published' or exists(select 1 from api.route_stop_executions execution
              join api.route_versions version on version.id=execution.route_version_id
              where version.route_id=(draft ->> 'routeId')::uuid and execution.status <> 'pending') then
            raise exception using errcode='P0001',message='VERSION_CONFLICT';
          end if;
          update api.route_versions set status='superseded',superseded_at=clock_timestamp()
            where route_id=(draft ->> 'routeId')::uuid and status='published' and superseded_at is null;
          update api.routes set status='cancelled',lock_version=lock_version+1
            where id=(draft ->> 'routeId')::uuid and status='published'
              and lock_version=(draft ->> 'expectedVersion')::integer;
          if not found then raise exception using errcode='P0001',message='VERSION_CONFLICT'; end if;
          insert into private.audit_events(actor_id,target_type,target_id,action,before_data,after_data,reason,origin)
            values(actor,'route',(draft ->> 'routeId')::uuid,'route.cancelled.by-weekly-proposal',draft,
              jsonb_build_object('status','cancelled','proposalId',row.id,'proposalVersion',row.version),
              'Dia removido da proposta semanal aprovada.','system');
        end if;
      end if;
    end loop;
    update api.weekly_route_proposals set status='published',published_by=actor,published_at=clock_timestamp(),
      route_ids=routes,updated_at=clock_timestamp() where id=p_id;
  else
    update api.weekly_route_proposals set status='rejected',updated_at=clock_timestamp() where id=p_id;
  end if;
  result := private.weekly_route_proposal_document(p_id);
  insert into private.weekly_route_proposal_commands values(actor,key,decision,p_id,p_command,result,now());
  insert into private.audit_events(actor_id,target_type,target_id,action,before_data,after_data,reason,origin,request_id)
    values(actor,'weekly_route_proposal',p_id,'weekly_route_proposal.'||decision,jsonb_build_object('version',expected),result,reason,'system',key);
  return result;
end
$function$;

create function private.capture_daily_seller_location(p_command jsonb)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $function$
declare
  identity_document jsonb := private.route_identity('route.read_self'); actor uuid := (identity_document ->> 'id')::uuid;
  key uuid; captured timestamptz; lat double precision; lng double precision; accuracy double precision;
  row api.seller_daily_route_locations%rowtype; replay private.weekly_route_proposal_commands%rowtype; result jsonb;
begin
  begin key := (p_command ->> 'idempotencyKey')::uuid; captured := (p_command ->> 'capturedAt')::timestamptz;
    lat := (p_command ->> 'latitude')::double precision; lng := (p_command ->> 'longitude')::double precision;
    accuracy := (p_command ->> 'accuracyM')::double precision;
  exception when others then raise exception using errcode='P0001', message='VALIDATION_FAILED'; end;
  select * into replay from private.weekly_route_proposal_commands where actor_id=actor and idempotency_key=key;
  if found then
    if replay.operation <> 'capture_location' or replay.command <> p_command then raise exception using errcode='P0001', message='VERSION_CONFLICT'; end if;
    return replay.response;
  end if;
  if captured is null or lat is null or lng is null or accuracy is null
     or captured > clock_timestamp() + interval '1 minute'
     or captured < clock_timestamp() - interval '5 minutes' or accuracy > 100 then
    raise exception using errcode='P0001', message='VALIDATION_FAILED'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    actor::text||':'||((captured at time zone 'America/Sao_Paulo')::date)::text,0));
  insert into api.seller_daily_route_locations(id,seller_id,service_date,version,latitude,longitude,accuracy_m,captured_at,captured_by)
  values(gen_random_uuid(),actor,(captured at time zone 'America/Sao_Paulo')::date,
    coalesce((select max(version)+1 from api.seller_daily_route_locations where seller_id=actor and service_date=(captured at time zone 'America/Sao_Paulo')::date),1),
    lat,lng,accuracy,captured,actor) returning * into row;
  result := jsonb_build_object('kind','current_gps','locationId',row.id,'sellerId',row.seller_id,'latitude',row.latitude,
    'longitude',row.longitude,'accuracyM',row.accuracy_m,'capturedAt',row.captured_at,'capturedBy',row.captured_by,'version',row.version);
  insert into private.weekly_route_proposal_commands values(actor,key,'capture_location',row.id,p_command,result,now());
  insert into private.audit_events(actor_id,target_type,target_id,action,after_data,origin,request_id)
    values(actor,'seller_daily_route_location',row.id,'seller_daily_route_location.captured',result,'pwa',key);
  return result;
end
$function$;

create function api.save_weekly_route_proposal(p_command jsonb) returns jsonb
language sql volatile security definer set search_path='' as $function$ select private.save_weekly_route_proposal(p_command); $function$;
create function api.revise_weekly_route_proposal(p_id uuid,p_command jsonb) returns jsonb
language sql volatile security definer set search_path='' as $function$ select private.revise_weekly_route_proposal(p_id,p_command); $function$;
create function api.decide_weekly_route_proposal(p_id uuid,p_command jsonb) returns jsonb
language sql volatile security definer set search_path='' as $function$ select private.decide_weekly_route_proposal(p_id,p_command); $function$;
create function api.get_weekly_route_proposal(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $function$
declare identity_document jsonb:=private.route_identity('route.plan_scoped'); result jsonb;
begin select private.weekly_route_proposal_document(row.id) into result from api.weekly_route_proposals row
  where row.id=p_id and exists(select 1 from jsonb_array_elements_text(identity_document -> 'scopeIds') scope where scope::uuid=row.seller_id);
  if result is null then raise exception using errcode='P0001',message='NOT_FOUND'; end if; return result; end $function$;
create function api.capture_daily_seller_location(p_command jsonb) returns jsonb
language sql volatile security definer set search_path='' as $function$ select private.capture_daily_seller_location(p_command); $function$;
create function api.get_scrap_ledger_generation_metadata() returns jsonb
language plpgsql stable security definer set search_path='' as $function$
declare identity_document jsonb:=private.route_identity('scrap_ledger.sync'); result jsonb;
begin
  select jsonb_build_object('generationId',head.generation_id,'publishedAt',run.completed_at)
    into result from private.scrap_ledger_head head join private.scrap_ledger_runs run on run.id=head.generation_id
    where head.singleton and run.status='published';
  if result is null then raise exception using errcode='P0001',message='NOT_FOUND'; end if;
  return result;
end $function$;

revoke all on table api.weekly_route_proposals,api.seller_daily_route_locations from public,anon,authenticated;
revoke all on table private.weekly_route_proposal_commands from public,anon,authenticated;
revoke all on function private.weekly_route_proposal_document(uuid),private.validate_weekly_route_proposal(uuid,date,jsonb),
  private.save_weekly_route_proposal(jsonb),private.revise_weekly_route_proposal(uuid,jsonb),
  private.decide_weekly_route_proposal(uuid,jsonb),private.capture_daily_seller_location(jsonb)
  from public,anon,authenticated,service_role;
revoke all on function api.save_weekly_route_proposal(jsonb),api.revise_weekly_route_proposal(uuid,jsonb),
  api.decide_weekly_route_proposal(uuid,jsonb),api.get_weekly_route_proposal(uuid),api.capture_daily_seller_location(jsonb) from public,anon;
revoke all on function api.get_scrap_ledger_generation_metadata() from public,anon;
grant execute on function api.save_weekly_route_proposal(jsonb),api.revise_weekly_route_proposal(uuid,jsonb),
  api.decide_weekly_route_proposal(uuid,jsonb),api.get_weekly_route_proposal(uuid),api.capture_daily_seller_location(jsonb) to authenticated;
grant execute on function api.get_scrap_ledger_generation_metadata() to authenticated;

reset role;
revoke create on schema api,private from cirne_route_executor;
revoke references on table api.user_profiles from cirne_route_executor;
do $ownership$
begin execute pg_catalog.format('revoke cirne_route_executor from %I granted by current_user',current_user); end
$ownership$;

commit;
