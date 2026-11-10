begin;

-- Additive evolution: no historical proposal, route or visit is rewritten.
do $membership$
begin
  execute pg_catalog.format('grant cirne_route_executor to %I with set true granted by current_user',current_user);
  execute pg_catalog.format('grant cirne_visit_executor to %I with set true granted by current_user',current_user);
end $membership$;
grant create on schema api to cirne_visit_executor;
set local role cirne_visit_executor;
grant select on api.visits to cirne_route_executor;
create policy visits_route_coverage_read on api.visits for select to cirne_route_executor using(true);
create index visits_completed_client_coverage on api.visits(client_id,server_completed_at desc,id desc)
  where status='completed' and server_completed_at is not null;
reset role;
revoke create on schema api from cirne_visit_executor;
grant create on schema api,private to cirne_route_executor;
set local role cirne_route_executor;

alter table api.weekly_route_proposals
  add column predecessor_id uuid references api.weekly_route_proposals(id) on delete restrict,
  add column predecessor_version integer check(predecessor_version > 0),
  add constraint weekly_route_proposal_predecessor_check check
    ((predecessor_id is null) = (predecessor_version is null));
create index weekly_route_proposals_predecessor on api.weekly_route_proposals(predecessor_id)
  where predecessor_id is not null;
-- One published version remains live while its successor is being reviewed.
drop index api.weekly_route_proposals_active_key;
create unique index weekly_route_proposals_draft_key on api.weekly_route_proposals(seller_id,week_start) where status='draft';
create unique index weekly_route_proposals_published_key on api.weekly_route_proposals(seller_id,week_start) where status='published';
alter table private.weekly_route_proposal_commands drop constraint weekly_route_proposal_commands_operation_check;
alter table private.weekly_route_proposal_commands add constraint weekly_route_proposal_commands_operation_check
  check(operation in ('save','revise','regenerate','publish','reject','capture_location'));

create or replace function private.weekly_route_proposal_document(p_id uuid)
returns jsonb language sql stable security definer set search_path=''
as $function$
  select jsonb_build_object('schemaVersion',1,'proposalId',row.id,'version',row.version,
    'status',row.status,'proposal',row.proposal,'createdBy',row.created_by,'createdAt',row.created_at,
    'updatedAt',row.updated_at,'publishedBy',row.published_by,'publishedAt',row.published_at,
    'routeIds',to_jsonb(row.route_ids),'predecessorId',row.predecessor_id,'predecessorVersion',row.predecessor_version)
  from api.weekly_route_proposals row where row.id=p_id;
$function$;

create function api.list_seller_client_visit_coverage(p_seller_id uuid)
returns jsonb language plpgsql stable security definer set search_path=''
as $function$
declare identity_document jsonb := private.route_identity('route.plan_scoped'); result jsonb;
begin
  if not exists(select 1 from jsonb_array_elements_text(identity_document -> 'scopeIds') scope where scope::uuid=p_seller_id) then
    raise exception using errcode='P0001',message='NOT_FOUND';
  end if;
  select jsonb_build_object('schemaVersion',1,'sellerId',p_seller_id,'source','api.visits',
    'observedAt',statement_timestamp(),'clients',coalesce(jsonb_agg(jsonb_build_object(
      'clientId',scope.client_id,'lastCompletedVisitAt',visit.server_completed_at,'visitId',visit.id)
      order by scope.client_id),'[]'::jsonb)) into result
  from api.client_seller_scopes scope
  join api.clients client on client.id=scope.client_id and client.archived_at is null
  left join lateral(select v.id,v.server_completed_at from api.visits v
    where v.client_id=scope.client_id and v.status='completed' and v.server_completed_at is not null
    order by v.server_completed_at desc,v.id desc limit 1) visit on true
  where scope.seller_id=p_seller_id and scope.revoked_at is null;
  return result;
end $function$;

create function api.get_active_weekly_route_proposal(p_seller_id uuid,p_week_start date)
returns jsonb language plpgsql stable security definer set search_path=''
as $function$
declare identity_document jsonb := private.route_identity('route.plan_scoped'); result jsonb;
begin
  select private.weekly_route_proposal_document(row.id) into result
  from api.weekly_route_proposals row where row.seller_id=p_seller_id and row.week_start=p_week_start
    and row.status in ('draft','published')
    and exists(select 1 from jsonb_array_elements_text(identity_document -> 'scopeIds') scope where scope::uuid=row.seller_id)
  order by (row.status='draft') desc,row.version desc limit 1;
  if result is null then raise exception using errcode='P0001',message='NOT_FOUND'; end if;
  return result;
end $function$;

-- Keep the strict legacy validator for old persisted documents. V3 is validated
-- explicitly, then normalized into that same canonical composition validator.
alter function private.validate_weekly_route_proposal(uuid,date,jsonb) rename to validate_weekly_route_proposal_v2;
do $reasons$
declare definition text;
begin
  definition := pg_get_functiondef('private.validate_weekly_route_proposal_v2(uuid,date,jsonb)'::regprocedure);
  definition := replace(definition,'''daily_capacity_reached'')','''daily_capacity_reached'',''weekly_strategy_mismatch'')');
  execute definition;
end $reasons$;
create function private.validate_weekly_route_proposal(p_seller uuid,p_week date,p_proposal jsonb)
returns void language plpgsql stable security definer set search_path=''
as $function$
declare normalized jsonb; day jsonb; item jsonb; previous_location extensions.geography;
  current_location extensions.geography; last_visit timestamptz; coverage_date date; last_purchase date;
begin
  if p_proposal #>> '{policy,version}' = 'weekly-route-rules-v2' then
    perform private.validate_weekly_route_proposal_v2(p_seller,p_week,p_proposal);
    return;
  end if;
  if jsonb_typeof(p_proposal) is distinct from 'object'
    or (select count(*) from jsonb_object_keys(p_proposal)) <> 12
    or not p_proposal ? 'strategy'
    or p_proposal #>> '{policy,version}' is distinct from 'weekly-route-rules-v3'
    or (select count(*) from jsonb_object_keys(p_proposal -> 'policy')) <> 8
    or p_proposal #> '{policy,coverageCadenceDays}' is distinct from '28'::jsonb
    or p_proposal #> '{policy,tripFromBaseDistanceKm}' is distinct from '80'::jsonb
    or jsonb_typeof(p_proposal -> 'strategy') is distinct from 'object'
    or (select count(*) from jsonb_object_keys(p_proposal -> 'strategy')) <> 3
    or not (p_proposal -> 'strategy') ?& array['kind','region','distanceFromBaseKm']
    or coalesce(p_proposal #>> '{strategy,kind}','') not in ('local','trip','pending')
    or coalesce(jsonb_typeof(p_proposal #> '{strategy,region}'),'') not in ('string','null')
    or coalesce(jsonb_typeof(p_proposal #> '{strategy,distanceFromBaseKm}'),'') not in ('number','null')
    or (p_proposal #>> '{strategy,distanceFromBaseKm}')::numeric < 0
    or (select count(*) from jsonb_object_keys(p_proposal -> 'sources')) <> 3
    or jsonb_typeof(p_proposal #> '{sources,visits}') is distinct from 'object'
    or (select count(*) from jsonb_object_keys(p_proposal #> '{sources,visits}')) <> 2
    or not (p_proposal #> '{sources,visits}') ?& array['status','asOfDate']
    or coalesce(p_proposal #>> '{sources,visits,status}','') not in ('available','unavailable')
    or coalesce(jsonb_typeof(p_proposal #> '{sources,visits,asOfDate}'),'') not in ('string','null')
    or (p_proposal #>> '{sources,visits,status}'='available' and (p_proposal #>> '{sources,visits,asOfDate}')::date is null)
    or (select count(*) from jsonb_object_keys(p_proposal -> 'counts')) <> 8
    or not (p_proposal -> 'counts') ?& array['coverageDue','coveragePlanned','coveragePending'] then
    raise exception using errcode='P0001',message='VALIDATION_FAILED';
  end if;
  coverage_date := (p_proposal #>> '{sources,visits,asOfDate}')::date;
  if exists(select 1 from jsonb_each(p_proposal -> 'counts') field
    where field.key in ('coverageDue','coveragePlanned','coveragePending') and
      (jsonb_typeof(field.value) <> 'number' or (field.value #>> '{}')::numeric < 0
        or (field.value #>> '{}')::numeric <> trunc((field.value #>> '{}')::numeric)))
    or (p_proposal #>> '{counts,coveragePlanned}')::integer > (p_proposal #>> '{counts,suggested}')::integer
    or (p_proposal #>> '{counts,coverageDue}')::integer < (p_proposal #>> '{counts,coveragePlanned}')::integer
    or (p_proposal #>> '{counts,coveragePending}')::integer <
      (p_proposal #>> '{counts,coverageDue}')::integer - (p_proposal #>> '{counts,coveragePlanned}')::integer then
    raise exception using errcode='P0001',message='VALIDATION_FAILED';
  end if;
  normalized := p_proposal - 'strategy';
  normalized := jsonb_set(normalized,'{policy}',(normalized -> 'policy') - 'coverageCadenceDays' - 'tripFromBaseDistanceKm');
  normalized := jsonb_set(normalized,'{policy,version}','"weekly-route-rules-v2"'::jsonb);
  normalized := jsonb_set(normalized,'{sources}',(normalized -> 'sources') - 'visits');
  normalized := jsonb_set(normalized,'{counts}',(normalized -> 'counts') - 'coverageDue' - 'coveragePlanned' - 'coveragePending');
  normalized := jsonb_set(normalized,'{days}','[]'::jsonb);
  for day in select value from jsonb_array_elements(p_proposal -> 'days') loop
    previous_location := null;
    for item in select value from jsonb_array_elements(day -> 'suggestions') order by (value ->> 'plannedOrder')::integer loop
      if (select count(*) from jsonb_object_keys(item)) <> 13
        or not item ?& array['lastCompletedVisitAt','coverageState','coverageOverdueDays','nextVisitDueOn']
        or coalesce(jsonb_typeof(item -> 'lastCompletedVisitAt'),'') not in ('string','null')
        or coalesce(jsonb_typeof(item -> 'nextVisitDueOn'),'') not in ('string','null')
        or coalesce(jsonb_typeof(item -> 'coverageOverdueDays'),'') not in ('number','null')
        or coalesce(item ->> 'coverageState','') not in ('never_visited','overdue','due_this_week','covered','unavailable')
        or jsonb_array_length(item -> 'reasons') not between 1 and 8
        or exists(select 1 from jsonb_array_elements(item -> 'reasons') reason
          where jsonb_typeof(reason) <> 'string' or char_length(btrim(reason #>> '{}')) not between 1 and 180)
        or (item ->> 'coverageOverdueDays')::numeric < 0
        or (item ->> 'coverageOverdueDays')::numeric <> trunc((item ->> 'coverageOverdueDays')::numeric) then
        raise exception using errcode='P0001',message='VALIDATION_FAILED';
      end if;
      if p_proposal #>> '{sources,sales,status}' is distinct from 'available'
        or not exists(select 1 from private.sales_sync_runs run
          join private.sales_sources source on source.published_run_id=run.id
          where run.id=(p_proposal #>> '{sources,sales,generationId}')::uuid and run.status='published') then
        raise exception using errcode='P0001',message='VALIDATION_FAILED';
      end if;
      select max(line.sale_date) into last_purchase from private.sales_snapshot_lines line
        join api.clients client on client.external_reference=line.client_external_reference
        where client.id=(item ->> 'clientId')::uuid
          and line.run_id=(p_proposal #>> '{sources,sales,generationId}')::uuid
          and line.kind='sale' and line.volume>0
          and line.sale_date <= (p_proposal #>> '{sources,sales,asOfDate}')::date;
      if last_purchase is null or (p_proposal #>> '{sources,sales,asOfDate}')::date-last_purchase not between 0 and 180 then
        raise exception using errcode='P0001',message='VALIDATION_FAILED';
      end if;
      -- Reading uses server confirmation; purchase, planning and start never pay coverage.
      select max(v.server_completed_at) into last_visit from api.visits v
        where v.client_id=(item ->> 'clientId')::uuid and v.status='completed'
          and (v.server_completed_at at time zone 'America/Sao_Paulo')::date <= coverage_date;
      if p_proposal #>> '{sources,visits,status}' = 'unavailable' then
        if item ->> 'coverageState' <> 'unavailable' or item ->> 'lastCompletedVisitAt' is not null
          or item ->> 'nextVisitDueOn' is not null or item ->> 'coverageOverdueDays' is not null then
          raise exception using errcode='P0001',message='VALIDATION_FAILED';
        end if;
      elsif (item ->> 'lastCompletedVisitAt')::timestamptz is distinct from last_visit then
        raise exception using errcode='P0001',message='VALIDATION_FAILED';
      elsif last_visit is null then
        if item ->> 'coverageState' <> 'never_visited' or item ->> 'nextVisitDueOn' is not null
          or item ->> 'coverageOverdueDays' is not null then raise exception using errcode='P0001',message='VALIDATION_FAILED'; end if;
      else
        if (item ->> 'nextVisitDueOn')::date is distinct from (last_visit at time zone 'America/Sao_Paulo')::date + 28
          or item ->> 'coverageState' is distinct from (case
            when (last_visit at time zone 'America/Sao_Paulo')::date+28 < p_week then 'overdue'
            when (last_visit at time zone 'America/Sao_Paulo')::date+28 <= p_week+4 then 'due_this_week'
            else 'covered' end)
          or (item ->> 'coverageOverdueDays')::integer is distinct from greatest(0,p_week-((last_visit at time zone 'America/Sao_Paulo')::date+28)) then
          raise exception using errcode='P0001',message='VALIDATION_FAILED';
        end if;
      end if;
      select client.location into current_location from api.clients client where client.id=(item ->> 'clientId')::uuid;
      if current_location is not null then
        -- Same 6371 km spherical radius used by the deterministic domain motor.
        if previous_location is not null and extensions.st_distancesphere(
          previous_location::extensions.geometry,current_location::extensions.geometry,6371000) > 30000.000001 then
          raise exception using errcode='P0001',message='VALIDATION_FAILED';
        end if;
        previous_location := current_location;
      end if;
    end loop;
    normalized := jsonb_set(normalized,'{days}',(normalized -> 'days') || jsonb_build_array(jsonb_set(day,'{suggestions}',
      coalesce((select jsonb_agg((suggestion - 'lastCompletedVisitAt' - 'coverageState' - 'coverageOverdueDays' - 'nextVisitDueOn') ||
        jsonb_build_object('reasons',jsonb_build_array(suggestion #>> '{reasons,0}')) order by (suggestion ->> 'plannedOrder')::integer)
        from jsonb_array_elements(day -> 'suggestions') suggestion),'[]'::jsonb))));
  end loop;
  perform private.validate_weekly_route_proposal_v2(p_seller,p_week,normalized);
exception when invalid_text_representation or invalid_parameter_value or datetime_field_overflow or numeric_value_out_of_range then
  raise exception using errcode='P0001',message='VALIDATION_FAILED';
end $function$;

create function private.regenerate_weekly_route_proposal(p_id uuid,p_command jsonb)
returns jsonb language plpgsql volatile security definer set search_path=''
as $function$
declare identity_document jsonb := private.route_identity('route.plan_scoped'); actor uuid := (identity_document ->> 'id')::uuid;
  key uuid; expected integer; row api.weekly_route_proposals%rowtype;
  replay private.weekly_route_proposal_commands%rowtype; result jsonb; before_document jsonb; new_proposal jsonb;
begin
  begin
    key := (p_command ->> 'idempotencyKey')::uuid;
    expected := (p_command ->> 'expectedVersion')::integer;
  exception when others then raise exception using errcode='P0001',message='VALIDATION_FAILED'; end;
  if key is null or expected is null or expected < 1 or p_command ->> 'schemaVersion' is distinct from '1'
    or (select count(*) from jsonb_object_keys(p_command)) <> 4
    or not p_command ?& array['schemaVersion','idempotencyKey','expectedVersion','proposal'] then
    raise exception using errcode='P0001',message='VALIDATION_FAILED';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('weekly-command:'||actor::text||':'||key::text,0));
  select * into replay from private.weekly_route_proposal_commands where actor_id=actor and idempotency_key=key;
  if found then
    if replay.operation <> 'regenerate' or replay.target_id <> p_id or replay.command <> p_command then
      raise exception using errcode='P0001',message='IDEMPOTENCY_KEY_REUSED';
    end if;
    if not exists(select 1 from jsonb_array_elements_text(identity_document -> 'scopeIds') scope
      where scope=replay.response #>> '{proposal,sellerId}') then
      raise exception using errcode='P0001',message='NOT_FOUND';
    end if;
    return replay.response;
  end if;
  select * into row from api.weekly_route_proposals where id=p_id;
  if not found or not exists(select 1 from jsonb_array_elements_text(identity_document -> 'scopeIds') scope where scope::uuid=row.seller_id) then
    raise exception using errcode='P0001',message='NOT_FOUND';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('weekly-proposal:'||row.seller_id::text||':'||row.week_start::text,0));
  select * into row from api.weekly_route_proposals where id=p_id for update;
  if row.version <> expected or row.status not in ('draft','published')
    or (row.status='published' and exists(select 1 from api.weekly_route_proposals other
      where other.seller_id=row.seller_id and other.week_start=row.week_start and other.status='draft')) then
    raise exception using errcode='P0001',message='VERSION_CONFLICT';
  end if;
  new_proposal := p_command -> 'proposal';
  if new_proposal #>> '{policy,version}' is distinct from 'weekly-route-rules-v3' then
    raise exception using errcode='P0001',message='VALIDATION_FAILED';
  end if;
  perform private.validate_weekly_route_proposal(row.seller_id,row.week_start,new_proposal);
  before_document := private.weekly_route_proposal_document(p_id);
  if row.status='published' then
    insert into api.weekly_route_proposals(seller_id,week_start,version,proposal,source_policy_version,created_by,predecessor_id,predecessor_version)
    values(row.seller_id,row.week_start,row.version+1,new_proposal,new_proposal #>> '{policy,version}',actor,p_id,expected) returning * into row;
  else
    update api.weekly_route_proposals set proposal=new_proposal,version=version+1,
      source_policy_version=new_proposal #>> '{policy,version}',predecessor_id=p_id,predecessor_version=expected,updated_at=clock_timestamp()
      where id=p_id returning * into row;
  end if;
  result := private.weekly_route_proposal_document(row.id);
  insert into private.weekly_route_proposal_commands values(actor,key,'regenerate',p_id,p_command,result,now());
  insert into private.audit_events(actor_id,target_type,target_id,action,before_data,after_data,origin,request_id)
    values(actor,'weekly_route_proposal',row.id,'weekly_route_proposal.regenerated',before_document,result,'system',key);
  return result;
exception when unique_violation or serialization_failure or deadlock_detected then
  raise exception using errcode='P0001',message='VERSION_CONFLICT';
end $function$;

create function api.regenerate_weekly_route_proposal(p_id uuid,p_command jsonb)
returns jsonb language sql volatile security definer set search_path=''
as $function$ select private.regenerate_weekly_route_proposal(p_id,p_command); $function$;

-- Harden the existing entry points with the same lock ordering and error contract.
-- Assertions make a changed upstream definition fail the migration visibly.
do $evolve$
declare name text; original text; definition text;
begin
  foreach name in array array['save_weekly_route_proposal(jsonb)','revise_weekly_route_proposal(uuid,jsonb)','decide_weekly_route_proposal(uuid,jsonb)'] loop
    original := replace(pg_get_functiondef(('private.'||name)::regprocedure),E'\r\n',E'\n');
    definition := replace(original,'  select * into replay from private.weekly_route_proposal_commands',
      E'  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(''weekly-command:''||actor::text||'':''||key::text,0));\n  select * into replay from private.weekly_route_proposal_commands');
    if definition=original then raise exception 'Missing replay anchor in %',name; end if;
    if name='save_weekly_route_proposal(jsonb)' then
      definition := replace(definition,'  perform private.validate_weekly_route_proposal(seller,week,proposal);',
        E'  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(''weekly-proposal:''||seller::text||'':''||week::text,0));\n  perform private.validate_weekly_route_proposal(seller,week,proposal);');
    else
      definition := replace(definition,'  select * into row from api.weekly_route_proposals where id=p_id for update;',
        E'  select * into row from api.weekly_route_proposals where id=p_id;\n  if found then\n    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(''weekly-proposal:''||row.seller_id::text||'':''||row.week_start::text,0));\n  end if;\n  select * into row from api.weekly_route_proposals where id=p_id for update;');
    end if;
    -- A replay collision has a different cause from an optimistic concurrency conflict.
    definition := regexp_replace(definition,
      '(if replay[\s\S]*?message=)''VERSION_CONFLICT''','\1''IDEMPOTENCY_KEY_REUSED''');
    definition := replace(definition,'    return replay.response;',
      E'    if not exists(select 1 from jsonb_array_elements_text(identity_document -> ''scopeIds'') scope where scope=replay.response #>> ''{proposal,sellerId}'') then\n      raise exception using errcode=''P0001'',message=''NOT_FOUND'';\n    end if;\n    return replay.response;');
    if name='revise_weekly_route_proposal(uuid,jsonb)' then
      definition := replace(definition,'  perform private.validate_weekly_route_proposal(row.seller_id,row.week_start,revised);',
        E'  if revised #>> ''{policy,version}'' = ''weekly-route-rules-v3'' then\n    revised := jsonb_set(revised,''{counts,coveragePlanned}'',to_jsonb((select count(*)::integer from jsonb_array_elements(revised -> ''days'') d,jsonb_array_elements(d -> ''suggestions'') s where s ->> ''coverageState'' in (''never_visited'',''overdue'',''due_this_week''))));\n    revised := jsonb_set(revised,''{counts,coveragePending}'',to_jsonb(greatest(0,(revised #>> ''{counts,coverageDue}'')::integer-(revised #>> ''{counts,coveragePlanned}'')::integer)));\n  end if;\n  perform private.validate_weekly_route_proposal(row.seller_id,row.week_start,revised);');
      definition := replace(definition,
        '    update api.weekly_route_proposals set status=''superseded'',updated_at=clock_timestamp() where id=p_id;',
        E'    if exists(select 1 from api.weekly_route_proposals other where other.seller_id=row.seller_id and other.week_start=row.week_start and other.status=''draft'') then\n      raise exception using errcode=''P0001'',message=''VERSION_CONFLICT'';\n    end if;');
      definition := replace(definition,'source_policy_version,created_by)', 'source_policy_version,created_by,predecessor_id,predecessor_version)');
      definition := replace(definition,'row.source_policy_version,actor) returning', 'row.source_policy_version,actor,p_id,expected) returning');
    elsif name='decide_weekly_route_proposal(uuid,jsonb)' then
      definition := replace(definition,
        '    update api.weekly_route_proposals set status=''published'',published_by=actor,published_at=clock_timestamp(),',
        E'    update api.weekly_route_proposals set status=''superseded'',updated_at=clock_timestamp()\n      where seller_id=row.seller_id and week_start=row.week_start and status=''published'' and id<>p_id;\n    update api.weekly_route_proposals set status=''published'',published_by=actor,published_at=clock_timestamp(),');
    end if;
    definition := replace(definition,E'  return result;\nend',E'  return result;\nexception when unique_violation or serialization_failure or deadlock_detected then\n  raise exception using errcode=''P0001'',message=''VERSION_CONFLICT'';\nend');
    if position('weekly-proposal:' in definition)=0
      or position('IDEMPOTENCY_KEY_REUSED' in definition)=0
      or position('exception when unique_violation' in definition)=0 then
      raise exception 'Weekly proposal concurrency anchors changed in %',name;
    end if;
    execute definition;
  end loop;
end $evolve$;

revoke all on function private.validate_weekly_route_proposal(uuid,date,jsonb),
  private.validate_weekly_route_proposal_v2(uuid,date,jsonb),private.regenerate_weekly_route_proposal(uuid,jsonb)
  from public,anon,authenticated,service_role;
revoke all on function api.list_seller_client_visit_coverage(uuid),api.get_active_weekly_route_proposal(uuid,date),
  api.regenerate_weekly_route_proposal(uuid,jsonb) from public,anon,service_role;
grant execute on function api.list_seller_client_visit_coverage(uuid),api.get_active_weekly_route_proposal(uuid,date),
  api.regenerate_weekly_route_proposal(uuid,jsonb) to authenticated;

reset role;
revoke create on schema api,private from cirne_route_executor;
do $membership$
begin
  execute pg_catalog.format('revoke cirne_route_executor from %I granted by current_user',current_user);
  execute pg_catalog.format('revoke cirne_visit_executor from %I granted by current_user',current_user);
end $membership$;
commit;
