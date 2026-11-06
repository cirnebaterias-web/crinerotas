-- Story 4.17 / ADR 008: dispatched promises and actual logistics outcomes.
begin;
select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cirne:database:migrate'));
set local lock_timeout = '5s';

insert into api.role_permissions(role_id, permission_code) values
('00000000-0000-4000-8000-000000000002', 'scrap.dispatch_pickups'),
('00000000-0000-4000-8000-000000000003', 'scrap.dispatch_pickups'),
('00000000-0000-4000-8000-000000000004', 'scrap.execute_pickups');

alter table api.pickup_schedules drop constraint pickup_schedules_status_check;
alter table api.pickup_schedules add constraint pickup_schedules_status_check check(status in ('pending', 'completed'));
alter table api.pickup_schedules drop constraint pickup_schedules_retention_until_check;
alter table api.pickup_schedules add constraint pickup_schedules_retention_until_check
  check((status='pending' and retention_until is null) or
        (status='completed' and retention_until is not null and retention_until >= last_event_at + interval '5 years'));

create table api.logistics_pickups (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null unique references api.pickup_schedules(id) on delete restrict,
  promise_version integer not null check(promise_version>0),
  promised_weight_kg numeric not null check(promised_weight_kg>0 and promised_weight_kg<'Infinity'::numeric),
  client_name_snapshot text not null, address_snapshot text not null,
  document_snapshot text check(document_snapshot ~ '^(\d{11}|\d{14})$'),
  desired_date_snapshot date not null,
  period_snapshot text not null check(period_snapshot in ('morning','afternoon')),
  observation_snapshot text,
  operator_id uuid not null references api.user_profiles(id) on delete restrict,
  operator_name_snapshot text not null, route_date date not null,
  route_order integer not null check(route_order between 1 and 10000),
  assigned_by uuid not null references api.user_profiles(id) on delete restrict,
  assigned_at timestamptz not null,
  result_outcome text check(result_outcome in ('collected','not_collected')),
  actual_weight_kg numeric check(actual_weight_kg>=0 and actual_weight_kg<'Infinity'::numeric),
  result_reason text check(length(result_reason) between 1 and 1000),
  result_by uuid references api.user_profiles(id) on delete restrict,
  result_name_snapshot text, result_at timestamptz,
  original_result jsonb,
  original_result_by uuid references api.user_profiles(id) on delete restrict,
  review_reason text check(length(review_reason) between 1 and 1000),
  reviewed_by uuid references api.user_profiles(id) on delete restrict,
  reviewer_name_snapshot text, reviewed_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(operator_id, route_date, route_order),
  check((result_outcome is null and actual_weight_kg is null and result_by is null and result_at is null
    and original_result is null and original_result_by is null) or
    (result_outcome is not null and actual_weight_kg is not null and result_by is not null and result_at is not null
    and original_result is not null and original_result_by is not null)),
  check(result_outcome is null or (result_outcome='collected' and actual_weight_kg>0)
    or (result_outcome='not_collected' and actual_weight_kg=0)),
  check(actual_weight_kg is null or actual_weight_kg=promised_weight_kg or result_reason is not null),
  check((reviewed_by is null and review_reason is null and reviewed_at is null) or
    (reviewed_by is not null and review_reason is not null and reviewed_at is not null and result_outcome is not null))
);
create index logistics_pickups_assigned_by on api.logistics_pickups(assigned_by);
create index logistics_pickups_result_by on api.logistics_pickups(result_by);
create index logistics_pickups_original_result_by on api.logistics_pickups(original_result_by);
create index logistics_pickups_reviewed_by on api.logistics_pickups(reviewed_by);
create index logistics_pickups_route_date on api.logistics_pickups(route_date, operator_id, route_order);

create table api.logistics_pickup_events (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references api.pickup_schedules(id) on delete restrict,
  actor_id uuid not null references api.user_profiles(id) on delete restrict,
  actor_name_snapshot text not null,
  action text not null check(action in ('assigned','result_recorded','result_corrected','reviewed')),
  reason text, before_data jsonb, after_data jsonb not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index logistics_pickup_events_schedule on api.logistics_pickup_events(schedule_id, created_at, id);
create index logistics_pickup_events_actor on api.logistics_pickup_events(actor_id);
comment on table api.logistics_pickups is 'Immutable dispatched promise and current logistics outcome; never a seller collection or Cirne receipt.';
comment on table api.logistics_pickup_events is 'Append-only assignment, actual outcome, correction and review history; protected from deletion.';

do $roles$ begin
  execute format('grant cirne_scrap_executor to %I with set true granted by current_user', current_user);
end $roles$;
grant usage, create on schema api, private to cirne_scrap_executor;
grant select on api.roles, api.user_role_assignments to cirne_scrap_executor;
create policy roles_logistics_read on api.roles for select to cirne_scrap_executor using(true);
create policy assignments_logistics_read on api.user_role_assignments for select to cirne_scrap_executor using(true);
do $tables$ declare t text; begin
  foreach t in array array['api.logistics_pickups','api.logistics_pickup_events'] loop
    execute format('alter table %s enable row level security', t);
    execute format('alter table %s force row level security', t);
    execute format('revoke all on %s from public, anon, authenticated', t);
    execute format('grant select, insert, update on %s to cirne_scrap_executor', t);
    execute format('create policy logistics_executor on %s for all to cirne_scrap_executor using(true) with check(true)', t);
  end loop;
end $tables$;
revoke update on api.logistics_pickup_events from cirne_scrap_executor;

set local role cirne_scrap_executor;
create function private.logistics_manager(p_identity jsonb, p_seller uuid default null)
returns boolean language sql immutable set search_path='' as $$
  select coalesce(p_identity->>'status'='active'
    and p_identity->'capabilities' ? 'scrap.dispatch_pickups'
    and (p_identity->'roles' ? 'administrator' or
      (p_identity->'roles' ? 'manager' and jsonb_array_length(p_identity->'scopeIds')>0
        and (p_seller is null or p_identity->'scopeIds' ? p_seller::text))),false);
$$;
create function private.logistics_operator(p_identity jsonb)
returns boolean language sql immutable set search_path='' as $$
  select coalesce(p_identity->>'status'='active' and p_identity->'roles' ? 'logistics'
    and p_identity->'capabilities' ? 'scrap.execute_pickups',false);
$$;

create function private.logistics_snapshot(p_record jsonb)
returns jsonb language sql immutable set search_path='' as $$
  select jsonb_build_object('promisedWeightKg',p_record->'promisedWeightKg',
    'desiredDate',p_record->'desiredDate','period',p_record->'period','observation',p_record->'observation',
    'assignment',p_record->'assignment','result',p_record->'result','review',p_record->'review');
$$;

create function private.logistics_pickup_projection(p_schedule_id uuid, p_history boolean default true)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare s api.pickup_schedules%rowtype; l api.logistics_pickups%rowtype;
  document_value text; result_value jsonb; review_value jsonb; assignment_value jsonb;
  history_value jsonb:='[]'; initial_schedule jsonb;
begin
  select * into s from api.pickup_schedules where id=p_schedule_id;
  select * into l from api.logistics_pickups where schedule_id=p_schedule_id;
  if l.id is null then
    select case when regexp_replace(c.external_reference,'[^0-9]','','g') ~ '^(\d{11}|\d{14})$'
      and c.external_reference ~ '^[0-9./[:space:]-]+$'
      then regexp_replace(c.external_reference,'[^0-9]','','g') end
      into document_value from api.clients c where c.id=s.client_id;
  else
    document_value:=l.document_snapshot;
    assignment_value:=jsonb_build_object('operator',jsonb_build_object('id',l.operator_id,'displayName',l.operator_name_snapshot),
      'routeDate',l.route_date,'routeOrder',l.route_order,'assignedAt',l.assigned_at);
    if l.result_outcome is not null then
      result_value:=jsonb_build_object('outcome',l.result_outcome,'actualWeightKg',l.actual_weight_kg::text,
        'differenceKg',(l.actual_weight_kg-l.promised_weight_kg)::text,'reason',l.result_reason,
        'recordedBy',jsonb_build_object('id',l.result_by,'displayName',l.result_name_snapshot),'recordedAt',l.result_at);
    end if;
    if l.reviewed_by is not null then
      review_value:=jsonb_build_object('reason',l.review_reason,
        'reviewedBy',jsonb_build_object('id',l.reviewed_by,'displayName',l.reviewer_name_snapshot),'reviewedAt',l.reviewed_at);
    end if;
  end if;
  if p_history then
    select r.before_data into initial_schedule from api.pickup_schedule_revisions r where r.schedule_id=s.id order by r.created_at,r.id limit 1;
    initial_schedule:=coalesce(initial_schedule,to_jsonb(s));
    select jsonb_agg(event.data order by event.stamp,event.priority,event.id) into history_value from (
      select s.created_at stamp,0 priority,s.id id,jsonb_build_object('action','schedule_created',
        'actor',jsonb_build_object('id',s.seller_id,'displayName',s.seller_name_snapshot),
        'occurredAt',s.created_at,'reason',null,'before',null,'after',jsonb_build_object(
          'promisedWeightKg',initial_schedule->>'estimated_weight_kg','desiredDate',initial_schedule->'desired_date',
          'period',initial_schedule->'period','observation',initial_schedule->'observation')) data
      union all
      select r.created_at,1,r.id,jsonb_build_object('action','schedule_revised',
        'actor',jsonb_build_object('id',r.actor_id,'displayName',p.display_name),'occurredAt',r.created_at,'reason',r.reason,
        'before',jsonb_build_object('promisedWeightKg',r.before_data->>'estimated_weight_kg','desiredDate',r.before_data->'desired_date','period',r.before_data->'period','observation',r.before_data->'observation'),
        'after',jsonb_build_object('promisedWeightKg',r.after_data->>'estimated_weight_kg','desiredDate',r.after_data->'desired_date','period',r.after_data->'period','observation',r.after_data->'observation'))
      from api.pickup_schedule_revisions r join api.user_profiles p on p.id=r.actor_id where r.schedule_id=s.id
      union all
      select e.created_at,2,e.id,jsonb_build_object('action',e.action,
        'actor',jsonb_build_object('id',e.actor_id,'displayName',e.actor_name_snapshot),'occurredAt',e.created_at,
        'reason',e.reason,'before',e.before_data,'after',e.after_data)
      from api.logistics_pickup_events e where e.schedule_id=s.id
    ) event;
  end if;
  return jsonb_build_object('scheduleId',s.id,'version',s.version,
    'client',jsonb_build_object('id',s.client_id,'name',coalesce(l.client_name_snapshot,s.client_name_snapshot),
      'address',coalesce(l.address_snapshot,s.address_snapshot),'document',document_value),
    'seller',jsonb_build_object('id',s.seller_id,'displayName',s.seller_name_snapshot),
    'promisedWeightKg',coalesce(l.promised_weight_kg,s.estimated_weight_kg)::text,
    'desiredDate',coalesce(l.desired_date_snapshot,s.desired_date),'period',coalesce(l.period_snapshot,s.period),
    'observation',case when l.id is null then s.observation else l.observation_snapshot end,
    'assignment',assignment_value,'result',result_value,'resultOriginal',l.original_result,'review',review_value,
    'reviewRequired',coalesce(l.actual_weight_kg<>l.promised_weight_kg and l.reviewed_by is null,false),
    'history',coalesce(history_value,'[]'));
end $$;

create function api.list_logistics_operators()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare d jsonb:=private.resolve_current_identity(); rows jsonb;
begin
  if not private.logistics_manager(d) then raise exception using errcode='P0001',message='FORBIDDEN'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'displayName',p.display_name) order by p.display_name,p.id),'[]') into rows
  from api.user_profiles p where p.status='active' and p.blocked_at is null and exists(
    select 1 from api.user_role_assignments a join api.roles r on r.id=a.role_id
    where a.user_id=p.id and a.revoked_at is null and r.code='logistics');
  return jsonb_build_object('schemaVersion',1,'operators',rows);
end $$;

create function api.list_logistics_pickups(p_date date)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare d jsonb:=private.resolve_current_identity(); rows jsonb; totals jsonb;
begin
  if not private.logistics_manager(d) and not private.logistics_operator(d) then
    raise exception using errcode='P0001',message='FORBIDDEN'; end if;
  if p_date is null then raise exception using errcode='P0001',message='VALIDATION_FAILED'; end if;
  with visible as materialized (
    select s.id,coalesce(l.promised_weight_kg,s.estimated_weight_kg) promised,l.actual_weight_kg,
      l.reviewed_by,l.route_order,l.operator_id,s.desired_date
    from api.pickup_schedules s left join api.logistics_pickups l on l.schedule_id=s.id
    where (private.logistics_manager(d,s.seller_id) and
      ((l.id is null and s.status='pending' and s.desired_date<=p_date) or l.route_date=p_date))
      or (private.logistics_operator(d) and l.operator_id=(d->>'id')::uuid and l.route_date=p_date)
  ) select coalesce(jsonb_agg(private.logistics_pickup_projection(id) order by route_order nulls last,operator_id,desired_date,id),'[]'),
    jsonb_build_object('promisedWeightKg',coalesce(sum(promised),0)::text,
      'collectedWeightKg',coalesce(sum(actual_weight_kg),0)::text,
      'differenceKg',coalesce(sum(actual_weight_kg-promised) filter(where actual_weight_kg is not null),0)::text,
      'pending',count(*) filter(where actual_weight_kg is null),
      'reviewRequired',count(*) filter(where actual_weight_kg<>promised and reviewed_by is null)) into rows,totals from visible;
  return jsonb_build_object('schemaVersion',1,'date',p_date,'generatedAt',clock_timestamp(),'records',rows,'totals',totals);
end $$;

create function api.change_logistics_pickup(p_schedule_id uuid,p_operation text,p_idempotency_key uuid,p_command jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare d jsonb:=private.resolve_current_identity(); actor_value uuid:=(d->>'id')::uuid;
  s api.pickup_schedules%rowtype; l api.logistics_pickups%rowtype; operator_row api.user_profiles%rowtype;
  previous private.scrap_commands%rowtype; digest_value text; action_value text; allowed text[];
  before_value jsonb; after_value jsonb; result_value jsonb; note text; new_kg numeric;
  new_date date; new_order integer; stamp timestamptz:=clock_timestamp();
begin
  if p_operation not in ('assignment','result','correction','review') or p_operation is null then
    raise exception using errcode='P0001',message='VALIDATION_FAILED'; end if;
  if (p_operation='result' and not private.logistics_operator(d)) or
    (p_operation<>'result' and not private.logistics_manager(d)) then
    raise exception using errcode='P0001',message='FORBIDDEN'; end if;
  allowed:=case p_operation when 'assignment' then array['schemaVersion','expectedVersion','operatorId','routeDate','routeOrder','reason']
    when 'review' then array['schemaVersion','expectedVersion','reason']
    else array['schemaVersion','expectedVersion','outcome','actualWeightKg','reason'] end;
  if p_schedule_id is null or p_idempotency_key is null or jsonb_typeof(p_command) is distinct from 'object'
    or p_command->'schemaVersion' is distinct from '1'::jsonb or (p_command-allowed)<>'{}'::jsonb
    or jsonb_typeof(p_command->'expectedVersion') is distinct from 'number'
    or p_command->>'expectedVersion' !~ '^[1-9][0-9]*$' then
    raise exception using errcode='P0001',message='VALIDATION_FAILED'; end if;
  if p_command ? 'reason' and jsonb_typeof(p_command->'reason') is distinct from 'string' then
    raise exception using errcode='P0001',message='VALIDATION_FAILED'; end if;
  note:=nullif(btrim(p_command->>'reason'),'');
  if length(coalesce(note,''))>1000 or (p_operation<>'result' and note is null) then
    raise exception using errcode='P0001',message='VALIDATION_FAILED'; end if;

  -- Always reauthorize current assignment/scope before returning an earlier command response.
  select * into s from api.pickup_schedules where id=p_schedule_id for update;
  select * into l from api.logistics_pickups where schedule_id=p_schedule_id;
  if s.id is null or (p_operation='result' and (l.id is null or l.operator_id<>actor_value))
    or (p_operation<>'result' and not private.logistics_manager(d,s.seller_id)) then
    raise exception using errcode='P0001',message='NOT_FOUND'; end if;
  action_value:='logistics.'||p_operation||'.v1';
  digest_value:=encode(extensions.digest(convert_to(jsonb_build_object('scheduleId',p_schedule_id,'command',p_command)::text,'UTF8'),'sha256'),'hex');
  perform pg_advisory_xact_lock(hashtextextended(actor_value::text||':'||action_value||':'||p_idempotency_key,1));
  select * into previous from private.scrap_commands command_row where command_row.actor_id=actor_value
    and command_row.operation=action_value and command_row.idempotency_key=p_idempotency_key;
  if previous.id is not null then
    if previous.payload_hash<>digest_value then raise exception using errcode='P0001',message='IDEMPOTENCY_KEY_REUSED'; end if;
    return previous.result;
  end if;
  if s.version is distinct from (p_command->>'expectedVersion')::integer then
    raise exception using errcode='P0001',message='VERSION_CONFLICT'; end if;
  before_value:=private.logistics_snapshot(private.logistics_pickup_projection(s.id,false));

  if p_operation='assignment' then
    if s.status<>'pending' or l.result_outcome is not null then raise exception using errcode='P0001',message='VERSION_CONFLICT'; end if;
    if jsonb_typeof(p_command->'operatorId') is distinct from 'string'
      or jsonb_typeof(p_command->'routeDate') is distinct from 'string'
      or p_command->>'routeDate' !~ '^\d{4}-\d{2}-\d{2}$'
      or jsonb_typeof(p_command->'routeOrder') is distinct from 'number'
      or p_command->>'routeOrder' !~ '^[1-9][0-9]*$' then raise exception using errcode='P0001',message='VALIDATION_FAILED'; end if;
    new_date:=(p_command->>'routeDate')::date; new_order:=(p_command->>'routeOrder')::integer;
    if new_order>10000 then raise exception using errcode='P0001',message='VALIDATION_FAILED'; end if;
    select * into operator_row from api.user_profiles p where p.id=(p_command->>'operatorId')::uuid
      and p.status='active' and p.blocked_at is null and exists(
        select 1 from api.user_role_assignments a join api.roles r on r.id=a.role_id
        where a.user_id=p.id and a.revoked_at is null and r.code='logistics');
    if operator_row.id is null then raise exception using errcode='P0001',message='VALIDATION_FAILED'; end if;
    perform pg_advisory_xact_lock(hashtextextended('logistics-route:'||operator_row.id::text||':'||new_date::text,1));
    if exists(select 1 from api.logistics_pickups where operator_id=operator_row.id and route_date=new_date
      and route_order=new_order and schedule_id<>s.id) then raise exception using errcode='P0001',message='VERSION_CONFLICT'; end if;
    if l.id is null then
      insert into api.logistics_pickups(schedule_id,promise_version,promised_weight_kg,client_name_snapshot,address_snapshot,
        document_snapshot,desired_date_snapshot,period_snapshot,observation_snapshot,operator_id,operator_name_snapshot,
        route_date,route_order,assigned_by,assigned_at)
      values(s.id,s.version,s.estimated_weight_kg,s.client_name_snapshot,s.address_snapshot,
        private.logistics_pickup_projection(s.id,false)#>>'{client,document}',s.desired_date,s.period,s.observation,
        operator_row.id,operator_row.display_name,new_date,new_order,actor_value,stamp);
    else
      update api.logistics_pickups set operator_id=operator_row.id,operator_name_snapshot=operator_row.display_name,
        route_date=new_date,route_order=new_order,assigned_by=actor_value,assigned_at=stamp,updated_at=stamp where schedule_id=s.id;
    end if;
  elsif p_operation in ('result','correction') then
    if l.id is null or (p_operation='result' and l.result_outcome is not null)
      or (p_operation='correction' and l.result_outcome is null) then raise exception using errcode='P0001',message='VERSION_CONFLICT'; end if;
    if jsonb_typeof(p_command->'actualWeightKg') is distinct from 'string'
      or length(p_command->>'actualWeightKg')>200
      or p_command->>'actualWeightKg' !~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$'
      or p_command->>'outcome' is null or p_command->>'outcome' not in ('collected','not_collected') then
      raise exception using errcode='P0001',message='VALIDATION_FAILED'; end if;
    new_kg:=(p_command->>'actualWeightKg')::numeric;
    if (p_command->>'outcome'='collected')<>(new_kg>0) or
      (new_kg<>l.promised_weight_kg and note is null) then raise exception using errcode='P0001',message='VALIDATION_FAILED'; end if;
    result_value:=jsonb_build_object('outcome',p_command->>'outcome','actualWeightKg',new_kg::text,
      'differenceKg',(new_kg-l.promised_weight_kg)::text,'reason',note,
      'recordedBy',jsonb_build_object('id',actor_value,'displayName',d->>'displayName'),'recordedAt',stamp);
    update api.logistics_pickups set result_outcome=p_command->>'outcome',actual_weight_kg=new_kg,
      result_reason=note,result_by=actor_value,result_name_snapshot=d->>'displayName',result_at=stamp,
      original_result=coalesce(original_result,result_value),original_result_by=coalesce(original_result_by,actor_value),
      review_reason=null,reviewed_by=null,reviewer_name_snapshot=null,reviewed_at=null,updated_at=stamp where schedule_id=s.id;
  else
    if l.result_outcome is null or l.actual_weight_kg=l.promised_weight_kg then
      raise exception using errcode='P0001',message='VERSION_CONFLICT'; end if;
    update api.logistics_pickups set review_reason=note,reviewed_by=actor_value,reviewer_name_snapshot=d->>'displayName',
      reviewed_at=stamp,updated_at=stamp where schedule_id=s.id;
  end if;
  update api.pickup_schedules set version=version+1,last_event_at=stamp,updated_at=stamp,
    status=case when p_operation='result' then 'completed' else status end,
    retention_until=case when p_operation='result' or status='completed'
      then greatest(retention_until,stamp+interval '5 years') else null end where id=s.id;
  after_value:=private.logistics_snapshot(private.logistics_pickup_projection(s.id,false));
  insert into api.logistics_pickup_events(schedule_id,actor_id,actor_name_snapshot,action,reason,before_data,after_data,created_at,updated_at)
  values(s.id,actor_value,d->>'displayName',case p_operation when 'assignment' then 'assigned' when 'result' then 'result_recorded'
    when 'correction' then 'result_corrected' else 'reviewed' end,note,before_value,after_value,stamp,stamp);
  result_value:=private.logistics_pickup_projection(s.id);
  perform private.scrap_audit(actor_value,s.id,action_value,before_value,after_value,p_idempotency_key);
  insert into private.scrap_commands(actor_id,operation,idempotency_key,payload_hash,result)
    values(actor_value,action_value,p_idempotency_key,digest_value,result_value);
  return result_value;
exception when check_violation or not_null_violation or invalid_text_representation or invalid_datetime_format
  or datetime_field_overflow or numeric_value_out_of_range then
  raise exception using errcode='P0001',message='VALIDATION_FAILED';
when unique_violation then raise exception using errcode='P0001',message='VERSION_CONFLICT';
end $$;

create function private.guard_logistics_promise()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if exists(select 1 from api.logistics_pickups where schedule_id=old.id) and
    (to_jsonb(new)-array['version','status','last_event_at','retention_until','updated_at']) is distinct from
    (to_jsonb(old)-array['version','status','last_event_at','retention_until','updated_at']) then
    raise exception using errcode='P0001',message='VERSION_CONFLICT';
  end if;
  return new;
end $$;
create function private.guard_logistics_original()
returns trigger language plpgsql set search_path='' as $$
begin
  if row(new.schedule_id,new.promise_version,new.promised_weight_kg,new.client_name_snapshot,new.address_snapshot,
    new.document_snapshot,new.desired_date_snapshot,new.period_snapshot,new.observation_snapshot,new.created_at)
    is distinct from row(old.schedule_id,old.promise_version,old.promised_weight_kg,old.client_name_snapshot,old.address_snapshot,
    old.document_snapshot,old.desired_date_snapshot,old.period_snapshot,old.observation_snapshot,old.created_at)
    or (old.original_result is not null and row(new.original_result,new.original_result_by) is distinct from row(old.original_result,old.original_result_by)) then
    raise exception using errcode='P0001',message='HISTORY_IMMUTABLE';
  end if;
  return new;
end $$;

-- Keep existing custody totals distinct; completed logistics attempts leave the pending schedule total.
alter function api.list_scrap_operations() rename to list_scrap_operations_before_logistics;
create function api.list_scrap_operations()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare original jsonb:=api.list_scrap_operations_before_logistics(); pending jsonb; total numeric;
begin
  select coalesce(jsonb_agg(item),'[]'),coalesce(sum((item->>'estimatedWeightKg')::numeric),0) into pending,total
    from jsonb_array_elements(original->'schedules') item where item->>'status'='pending';
  return jsonb_set(jsonb_set(original,'{schedules}',pending),'{totals,scheduledKg}',to_jsonb(total::text));
end $$;

revoke all on function private.logistics_manager(jsonb,uuid),private.logistics_operator(jsonb),
  private.logistics_snapshot(jsonb),private.logistics_pickup_projection(uuid,boolean),
  private.guard_logistics_promise(),private.guard_logistics_original(),api.list_scrap_operations_before_logistics()
  from public,anon,authenticated;
revoke all on function api.list_logistics_operators(),api.list_logistics_pickups(date),
  api.change_logistics_pickup(uuid,text,uuid,jsonb),api.list_scrap_operations() from public,anon,authenticated;
grant execute on function api.list_logistics_operators(),api.list_logistics_pickups(date),
  api.change_logistics_pickup(uuid,text,uuid,jsonb),api.list_scrap_operations() to authenticated;
reset role;

create trigger logistics_promise_immutable before update on api.pickup_schedules
  for each row execute function private.guard_logistics_promise();
create trigger logistics_original_immutable before update on api.logistics_pickups
  for each row execute function private.guard_logistics_original();
create trigger logistics_pickups_no_delete before delete on api.logistics_pickups
  for each row execute function private.prevent_scrap_history_delete();
create trigger logistics_pickup_events_no_delete before delete on api.logistics_pickup_events
  for each row execute function private.prevent_scrap_history_delete();
create trigger logistics_pickup_events_immutable before update on api.logistics_pickup_events
  for each row execute function private.guard_scrap_immutable_row();
revoke create on schema api,private from cirne_scrap_executor;
do $roles$ begin
  execute format('revoke cirne_scrap_executor from %I granted by current_user',current_user);
end $roles$;
notify pgrst,'reload schema';
commit;
