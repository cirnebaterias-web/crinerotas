-- Story 3.11: controlled XLSX client imports.
begin;

select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cirne:database:migrate'));
set local lock_timeout = '5s';

insert into api.role_permissions (role_id, permission_code)
values
  ('00000000-0000-4000-8000-000000000002', 'clients.read'),
  ('00000000-0000-4000-8000-000000000002', 'clients.import'),
  ('00000000-0000-4000-8000-000000000003', 'clients.read'),
  ('00000000-0000-4000-8000-000000000003', 'clients.import')
on conflict (role_id, permission_code) do nothing;

create table api.import_batches (
  id uuid primary key default gen_random_uuid(),
  source_name text not null check (char_length(btrim(source_name)) between 1 and 255),
  source_checksum text not null check (source_checksum ~ '^[0-9a-f]{64}$'),
  imported_by uuid not null references api.user_profiles(id) on delete restrict,
  status text not null check (status in ('processing','completed','completed_with_rejections','failed')),
  total_count integer not null default 0 check (total_count >= 0),
  accepted_count integer not null default 0 check (accepted_count >= 0),
  rejected_count integer not null default 0 check (rejected_count >= 0),
  imported_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint import_batches_importer_checksum_key unique (imported_by, source_checksum),
  constraint import_batches_counts_check check (
    status = 'processing' or accepted_count + rejected_count = total_count
  )
);

create table private.import_batch_rows (
  id uuid primary key default gen_random_uuid(),
  import_batch_id uuid not null references api.import_batches(id) on delete restrict,
  row_number integer not null check (row_number > 0),
  payload jsonb not null,
  status text not null check (status in ('accepted','rejected')),
  error_codes jsonb not null default '[]'::jsonb check (jsonb_typeof(error_codes) = 'array'),
  created_at timestamptz not null default now(),
  constraint import_batch_rows_batch_row_key unique (import_batch_id, row_number)
);

alter table api.client_seller_scopes
  add column managed_by_import_batch_id uuid references api.import_batches(id) on delete restrict;

create index import_batches_imported_at_idx on api.import_batches (imported_at desc);
create index import_batch_rows_batch_status_idx on private.import_batch_rows (import_batch_id, status, row_number);
create index client_seller_scopes_import_batch_idx on api.client_seller_scopes (managed_by_import_batch_id)
  where managed_by_import_batch_id is not null;

alter table api.import_batches enable row level security;
alter table api.import_batches force row level security;
alter table private.import_batch_rows enable row level security;
alter table private.import_batch_rows force row level security;
revoke all on api.import_batches, private.import_batch_rows from public, anon, authenticated;

grant select, insert, update on api.import_batches to cirne_route_executor;
grant select, insert on private.import_batch_rows to cirne_route_executor;
grant select on api.client_seller_scopes to cirne_route_executor;
grant select on api.roles, api.user_role_assignments to cirne_route_executor;
grant usage, create on schema api, private to cirne_route_executor;
grant usage on schema extensions to cirne_route_executor;

do $membership$
begin
  execute pg_catalog.format('grant cirne_route_executor to %I with set true granted by current_user', current_user);
end
$membership$;

create function private.client_import_identity()
returns jsonb language sql stable security definer set search_path = ''
as $function$ select private.route_identity('clients.import'); $function$;

create function private.valid_import_seller(p_email text)
returns uuid language sql stable security definer set search_path = ''
as $function$
  select profile.id
  from auth.users auth_user
  join api.user_profiles profile on profile.id = auth_user.id and profile.status = 'active'
  join api.user_role_assignments assignment on assignment.user_id = profile.id and assignment.revoked_at is null
  join api.roles role_row on role_row.id = assignment.role_id and role_row.code = 'seller'
  where pg_catalog.lower(auth_user.email) = pg_catalog.lower(pg_catalog.btrim(p_email))
  limit 1;
$function$;

create function private.import_seller_authorized(p_identity jsonb, p_seller_id uuid)
returns boolean language sql immutable security definer set search_path = ''
as $function$
  select p_identity -> 'roles' ? 'administrator'
    or p_identity -> 'scopeIds' ? p_seller_id::text;
$function$;

create function private.validate_client_import_sellers(p_emails text[])
returns jsonb language plpgsql stable security definer set search_path = ''
as $function$
declare
  invalid_emails jsonb;
  identity_document jsonb := private.client_import_identity();
begin
  select coalesce(jsonb_agg(email order by email), '[]'::jsonb) into invalid_emails
  from (
    select distinct normalized.email
    from (
      select pg_catalog.lower(pg_catalog.btrim(value)) as email,
        private.valid_import_seller(value) as seller_id
      from pg_catalog.unnest(p_emails) value
    ) normalized
    where normalized.seller_id is null
      or not private.import_seller_authorized(identity_document, normalized.seller_id)
  ) invalid;
  return invalid_emails;
end
$function$;

create function private.client_import_batch_document(p_batch_id uuid, p_replayed boolean)
returns jsonb language sql stable security definer set search_path = ''
as $function$
  select jsonb_build_object(
    'schemaVersion', 1, 'id', batch.id, 'sourceName', batch.source_name,
    'sourceChecksum', batch.source_checksum, 'status', batch.status,
    'totalCount', batch.total_count, 'acceptedCount', batch.accepted_count,
    'rejectedCount', batch.rejected_count, 'importedAt', batch.imported_at,
    'completedAt', batch.completed_at, 'replayed', p_replayed,
    'issues', coalesce((select jsonb_agg(jsonb_build_object(
      'rowNumber', row_data.row_number,
      'code', error_item ->> 'code',
      'message', error_item ->> 'message'
    ) order by row_data.row_number)
      from private.import_batch_rows row_data
      cross join lateral jsonb_array_elements(row_data.error_codes) error_item
      where row_data.import_batch_id = batch.id and row_data.status = 'rejected'), '[]'::jsonb)
  )
  from api.import_batches batch where batch.id = p_batch_id;
$function$;

create function private.execute_client_import(p_command jsonb, p_origin text default 'web')
returns jsonb language plpgsql volatile security definer set search_path = ''
as $function$
declare
  identity_document jsonb := private.client_import_identity();
  actor_id uuid := (identity_document ->> 'id')::uuid;
  existing_batch_id uuid;
  batch_id uuid;
  item jsonb;
  v_seller_id uuid;
  v_client_id uuid;
  old_client jsonb;
  accepted integer := 0;
  rejected integer := 0;
  total integer;
  row_no integer;
  row_status text;
  latitude_value double precision;
  longitude_value double precision;
begin
  if p_command is null
     or jsonb_typeof(p_command) is distinct from 'object'
     or jsonb_typeof(p_command -> 'schemaVersion') is distinct from 'number'
     or p_command -> 'schemaVersion' is distinct from '1'::jsonb
     or jsonb_typeof(p_command -> 'totalCount') is distinct from 'number'
     or coalesce(p_command ->> 'totalCount', '') !~ '^[0-9]+$'
     or (p_command ->> 'totalCount')::numeric > 5000
     or jsonb_typeof(p_command -> 'sourceName') is distinct from 'string'
     or char_length(btrim(p_command ->> 'sourceName')) not between 1 and 255
     or coalesce(p_command ->> 'sourceChecksum','') !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(p_command -> 'rows') is distinct from 'array'
     or jsonb_typeof(p_command -> 'issues') is distinct from 'array' then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  if p_origin is null or p_origin not in ('web', 'cli') then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  total := (p_command ->> 'totalCount')::integer;
  if jsonb_array_length(p_command -> 'rows') > 5000
     or jsonb_array_length(p_command -> 'issues') > 10000 then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_command -> 'rows') row_item
    where jsonb_typeof(row_item) is distinct from 'object'
      or jsonb_typeof(row_item -> 'rowNumber') is distinct from 'number'
      or coalesce(row_item ->> 'rowNumber', '') !~ '^[0-9]+$'
      or (row_item ->> 'rowNumber')::numeric < 2
  ) or exists (
    select 1 from jsonb_array_elements(p_command -> 'issues') issue_item
    where jsonb_typeof(issue_item) is distinct from 'object'
      or jsonb_typeof(issue_item -> 'rowNumber') is distinct from 'number'
      or coalesce(issue_item ->> 'rowNumber', '') !~ '^[0-9]+$'
      or (issue_item ->> 'rowNumber')::numeric < 1
  ) or (
    select count(*) <> count(distinct row_item ->> 'rowNumber')
    from jsonb_array_elements(p_command -> 'rows') row_item
  ) or exists (
    select 1
    from jsonb_array_elements(p_command -> 'rows') row_item
    join jsonb_array_elements(p_command -> 'issues') issue_item
      on issue_item ->> 'rowNumber' = row_item ->> 'rowNumber'
  ) then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;
  if (
    select count(distinct numbered.row_number)
    from (
      select row_item ->> 'rowNumber' as row_number
      from jsonb_array_elements(p_command -> 'rows') row_item
      union all
      select issue_item ->> 'rowNumber'
      from jsonb_array_elements(p_command -> 'issues') issue_item
      where (issue_item ->> 'rowNumber')::integer > 1
    ) numbered
  ) <> total then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
  end if;

  select id into existing_batch_id from api.import_batches
  where imported_by = actor_id and source_checksum = p_command ->> 'sourceChecksum';
  if existing_batch_id is not null then
    return private.client_import_batch_document(existing_batch_id, true);
  end if;

  insert into api.import_batches (source_name, source_checksum, imported_by, status, total_count)
  values (pg_catalog.left(p_command ->> 'sourceName', 255), p_command ->> 'sourceChecksum',
    actor_id, 'processing', total)
  returning id into batch_id;

  for item in select value from jsonb_array_elements(p_command -> 'issues') loop
    row_no := greatest(coalesce((item ->> 'rowNumber')::integer, 1), 1);
    insert into private.import_batch_rows (import_batch_id, row_number, payload, status, error_codes)
    values (batch_id, row_no, '{}'::jsonb, 'rejected', jsonb_build_array(jsonb_build_object(
      'code', pg_catalog.left(coalesce(item ->> 'code','INVALID_ROW'),80),
      'message', pg_catalog.left(coalesce(item ->> 'message','Linha inválida.'),300))))
    on conflict (import_batch_id, row_number) do update
      set error_codes = private.import_batch_rows.error_codes || excluded.error_codes;
  end loop;

  for item in select value from jsonb_array_elements(p_command -> 'rows') loop
    row_no := (item ->> 'rowNumber')::integer;
    begin
      v_seller_id := private.valid_import_seller(item ->> 'sellerEmail');
      if v_seller_id is null
         or not private.import_seller_authorized(identity_document, v_seller_id) then
        raise exception using errcode = 'P0001', message = 'SELLER_NOT_FOUND';
      end if;
      row_status := coalesce(item ->> 'status', 'active');
      if row_status not in ('active','archived') then
        raise exception using errcode = 'P0001', message = 'INVALID_STATUS';
      end if;
      latitude_value := nullif(item ->> 'latitude','')::double precision;
      longitude_value := nullif(item ->> 'longitude','')::double precision;

      select to_jsonb(client), client.id into old_client, v_client_id
      from api.clients client where client.external_reference = item ->> 'externalReference'
      for update;

      if v_client_id is not null
         and not (identity_document -> 'roles' ? 'administrator')
         and not exists (
           select 1 from api.client_seller_scopes scope
           where scope.client_id = v_client_id and scope.revoked_at is null
             and identity_document -> 'scopeIds' ? scope.seller_id::text
         ) then
        raise exception using errcode = 'P0001', message = 'CLIENT_OUT_OF_SCOPE';
      end if;

      if v_client_id is null then
        insert into api.clients (external_reference, name, address, location, portfolio_reference,
          status, created_from_import_batch_id, archived_at)
        values (item ->> 'externalReference', item ->> 'name', item ->> 'address',
          case when latitude_value is null then null else
            extensions.st_setsrid(extensions.st_makepoint(longitude_value, latitude_value),4326)::extensions.geography end,
          nullif(item ->> 'portfolioReference',''),
          case when row_status = 'archived' then 'inactive' else 'active' end,
          batch_id, case when row_status = 'archived' then now() else null end)
        returning id into v_client_id;
      else
        update api.clients set
          name = item ->> 'name', address = item ->> 'address',
          location = case when latitude_value is null then null else
            extensions.st_setsrid(extensions.st_makepoint(longitude_value, latitude_value),4326)::extensions.geography end,
          portfolio_reference = nullif(item ->> 'portfolioReference',''),
          status = case when row_status = 'archived' then 'inactive' else 'active' end,
          archived_at = case when row_status = 'archived' then coalesce(archived_at, now()) else null end
        where id = v_client_id;
      end if;

      perform private.apply_import_client_scope(v_client_id, v_seller_id, actor_id, batch_id);

      insert into private.audit_events
        (actor_id, target_type, target_id, action, before_data, after_data, origin)
      values (actor_id, 'client', v_client_id, 'client.imported', old_client,
        jsonb_build_object('externalReference', item ->> 'externalReference', 'batchId', batch_id,
          'sellerId', v_seller_id, 'status', row_status), p_origin);

      insert into private.import_batch_rows (import_batch_id, row_number, payload, status)
      values (batch_id, row_no, item - 'sellerEmail', 'accepted');
      accepted := accepted + 1;
    exception when others then
      insert into private.import_batch_rows (import_batch_id, row_number, payload, status, error_codes)
      values (batch_id, row_no, item - 'sellerEmail', 'rejected', jsonb_build_array(jsonb_build_object(
        'code', case when sqlerrm in ('SELLER_NOT_FOUND','INVALID_STATUS','CLIENT_OUT_OF_SCOPE') then sqlerrm else 'ROW_FAILED' end,
        'message', case when sqlerrm = 'SELLER_NOT_FOUND' then 'Vendedor inexistente, inativo ou sem papel de Vendedor.'
          when sqlerrm = 'INVALID_STATUS' then 'Status inválido.'
          when sqlerrm = 'CLIENT_OUT_OF_SCOPE' then 'Cliente fora da abrangência do Gestor.'
          else 'A linha não pôde ser importada.' end)))
      on conflict (import_batch_id, row_number) do update set
        status = 'rejected',
        error_codes = private.import_batch_rows.error_codes || excluded.error_codes;
      rejected := rejected + 1;
    end;
  end loop;

  select count(*) into rejected from private.import_batch_rows
  where import_batch_id = batch_id and status = 'rejected';
  update api.import_batches set accepted_count = accepted, rejected_count = rejected,
    total_count = accepted + rejected,
    status = case when rejected > 0 then 'completed_with_rejections' else 'completed' end,
    completed_at = now()
  where id = batch_id;
  return private.client_import_batch_document(batch_id, false);
exception when unique_violation then
  select id into existing_batch_id from api.import_batches
  where imported_by = actor_id and source_checksum = p_command ->> 'sourceChecksum';
  if existing_batch_id is not null then
    return private.client_import_batch_document(existing_batch_id, true);
  end if;
  raise;
end
$function$;

create function private.get_client_import(p_batch_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $function$
declare
  identity_document jsonb := private.client_import_identity();
  actor_id uuid := (identity_document ->> 'id')::uuid;
begin
  if not exists (
    select 1 from api.import_batches
    where id = p_batch_id
      and (imported_by = actor_id or identity_document -> 'roles' ? 'administrator')
  ) then
    raise exception using errcode = 'P0001', message = 'NOT_FOUND';
  end if;
  return private.client_import_batch_document(p_batch_id, false);
end
$function$;

create function private.list_import_clients(p_limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path = ''
as $function$
declare
  identity_document jsonb := private.route_identity('clients.read');
begin
  return coalesce((select jsonb_agg(jsonb_build_object(
    'id', selected.id, 'externalReference', selected.external_reference, 'name', selected.name,
    'address', selected.address, 'latitude', extensions.st_y(selected.location::extensions.geometry),
    'longitude', extensions.st_x(selected.location::extensions.geometry),
    'portfolioReference', selected.portfolio_reference, 'sellerEmail', private.user_email(selected.seller_id),
    'status', case when selected.status = 'active' then 'active' else 'archived' end
  ) order by selected.name, selected.id)
  from (
    select client.*, active_scope.seller_id
    from api.clients client
    left join lateral (
      select scope.seller_id from api.client_seller_scopes scope
      where scope.client_id = client.id and scope.revoked_at is null
        and (identity_document -> 'roles' ? 'administrator'
          or identity_document -> 'scopeIds' ? scope.seller_id::text)
      order by scope.created_at desc limit 1
    ) active_scope on true
    where identity_document -> 'roles' ? 'administrator'
      or (active_scope.seller_id is not null
        and identity_document -> 'scopeIds' ? active_scope.seller_id::text)
    order by client.name, client.id
    limit least(greatest(p_limit,1),100)
  ) selected), '[]'::jsonb);
end
$function$;

reset role;

create function api.validate_client_import_sellers(p_emails text[])
returns jsonb language sql stable security definer set search_path = ''
as $function$ select private.validate_client_import_sellers(p_emails); $function$;
create function api.execute_client_import(p_command jsonb, p_origin text default 'web')
returns jsonb language sql volatile security definer set search_path = ''
as $function$ select private.execute_client_import(p_command, p_origin); $function$;
create function api.get_client_import(p_batch_id uuid)
returns jsonb language sql stable security definer set search_path = ''
as $function$ select private.get_client_import(p_batch_id); $function$;
create function api.list_import_clients(p_limit integer default 50)
returns jsonb language sql stable security definer set search_path = ''
as $function$ select private.list_import_clients(p_limit); $function$;

alter table api.import_batches owner to cirne_route_executor;
alter table private.import_batch_rows owner to cirne_route_executor;
alter function private.client_import_identity() owner to cirne_route_executor;
alter function private.valid_import_seller(text) owner to cirne_route_executor;
alter function private.import_seller_authorized(jsonb, uuid) owner to cirne_route_executor;
alter function private.validate_client_import_sellers(text[]) owner to cirne_route_executor;
alter function private.client_import_batch_document(uuid, boolean) owner to cirne_route_executor;
alter function private.execute_client_import(jsonb, text) owner to cirne_route_executor;
alter function private.get_client_import(uuid) owner to cirne_route_executor;
alter function private.list_import_clients(integer) owner to cirne_route_executor;
alter function api.validate_client_import_sellers(text[]) owner to cirne_route_executor;
alter function api.execute_client_import(jsonb, text) owner to cirne_route_executor;
alter function api.get_client_import(uuid) owner to cirne_route_executor;
alter function api.list_import_clients(integer) owner to cirne_route_executor;

revoke all on function api.validate_client_import_sellers(text[]), api.execute_client_import(jsonb, text),
  api.get_client_import(uuid), api.list_import_clients(integer) from public, anon;
revoke all on function private.import_seller_authorized(jsonb, uuid) from public, anon, authenticated;
grant execute on function api.validate_client_import_sellers(text[]), api.execute_client_import(jsonb, text),
  api.get_client_import(uuid), api.list_import_clients(integer) to authenticated, service_role;
revoke create on schema api, private from cirne_route_executor;

do $membership$
begin
  execute pg_catalog.format('revoke cirne_route_executor from %I granted by current_user', current_user);
end
$membership$;

commit;
