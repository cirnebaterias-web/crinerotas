begin;

do $ownership$
begin
  execute pg_catalog.format('grant cirne_visit_executor to %I with set true granted by current_user', current_user);
end
$ownership$;
grant create on schema private to cirne_visit_executor;
set local role cirne_visit_executor;

create or replace function private.validate_visit_stock_details(p_details jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $function$
declare
  line jsonb;
  brand text;
  quantity integer;
  completed_brands text[] := '{}';
begin
  if p_details is null or jsonb_typeof(p_details) is distinct from 'object'
     or jsonb_typeof(p_details -> 'ownLines') is distinct from 'array'
     or (p_details ? 'competitorLines' and jsonb_typeof(p_details -> 'competitorLines') is distinct from 'array')
     or jsonb_array_length(p_details -> 'ownLines') > 200
     or jsonb_array_length(coalesce(p_details -> 'competitorLines', '[]'::jsonb)) > 200 then
    return false;
  end if;
  if p_details ? 'completedOwnBrands' then
    if jsonb_typeof(p_details -> 'completedOwnBrands') is distinct from 'array'
       or jsonb_array_length(p_details -> 'completedOwnBrands') > 4 then return false; end if;
    for brand in select value #>> '{}' from jsonb_array_elements(p_details -> 'completedOwnBrands') loop
      if brand is null or brand not in ('Heliar', 'América', 'Durex', 'ACDelco')
         or brand = any(completed_brands) then return false; end if;
      completed_brands := array_append(completed_brands, brand);
    end loop;
  end if;
  for line in select value from jsonb_array_elements(p_details -> 'ownLines') loop
    if jsonb_typeof(line) <> 'object' then return false; end if;
    brand := line ->> 'brand';
    if brand is null or brand not in ('Heliar', 'América', 'Durex', 'ACDelco')
       or exists (select 1 from jsonb_object_keys(line) supplied(key) where not (supplied.key = any(array[
         'brand', 'model', 'quantity', 'productCode', 'sku', 'unitWeightKg', 'catalogVersion', 'weightSource'
       ])))
       or jsonb_typeof(line -> 'model') is distinct from 'string'
       or char_length(btrim(line ->> 'model')) not between 1 and 120
       or jsonb_typeof(line -> 'quantity') is distinct from 'number'
       or (line ->> 'quantity') !~ '^[0-9]+$'
       or (line ? 'productCode' and (jsonb_typeof(line -> 'productCode') <> 'string' or char_length(btrim(line ->> 'productCode')) not between 1 and 60))
       or (line ? 'sku' and (jsonb_typeof(line -> 'sku') <> 'string' or char_length(btrim(line ->> 'sku')) not between 1 and 80))
       or (line ? 'unitWeightKg' and (jsonb_typeof(line -> 'unitWeightKg') <> 'string' or (line ->> 'unitWeightKg') !~ '^([0-9]+)(\.[0-9]+)?$' or (line ->> 'unitWeightKg')::numeric <= 0))
       or (line ? 'catalogVersion' and (jsonb_typeof(line -> 'catalogVersion') <> 'number' or (line ->> 'catalogVersion') !~ '^[1-9][0-9]*$'))
       or (line ? 'weightSource' and (line ->> 'weightSource') not in ('catalog', 'fallback_15kg')) then
      return false;
    end if;
    quantity := (line ->> 'quantity')::integer;
    if quantity < 0 then return false; end if;
  end loop;
  for line in select value from jsonb_array_elements(coalesce(p_details -> 'competitorLines', '[]'::jsonb)) loop
    if jsonb_typeof(line) <> 'object' then return false; end if;
    brand := line ->> 'brand';
    if brand is null or brand not in ('Moura', 'Zetta', 'Bosh', 'Tudor', 'Pioneiro', 'Outra')
       or exists (select 1 from jsonb_object_keys(line) supplied(key) where not (supplied.key = any(array['brand', 'amperage', 'technology', 'quantity', 'otherBrand'])))
       or jsonb_typeof(line -> 'amperage') is distinct from 'number'
       or (line ->> 'amperage') !~ '^[0-9]+$'
       or ((line ->> 'amperage')::integer not between 1 and 999)
       or jsonb_typeof(line -> 'technology') is distinct from 'string'
       or char_length(btrim(line ->> 'technology')) not between 1 and 60
       or jsonb_typeof(line -> 'quantity') is distinct from 'number'
       or (line ->> 'quantity') !~ '^[0-9]+$'
       or (line ->> 'quantity')::integer < 0
       or (brand = 'Outra' and (jsonb_typeof(line -> 'otherBrand') is distinct from 'string' or char_length(btrim(line ->> 'otherBrand')) not between 1 and 80)) then
      return false;
    end if;
  end loop;
  return true;
exception when invalid_text_representation or numeric_value_out_of_range then
  return false;
end
$function$;

revoke all on function private.validate_visit_stock_details(jsonb) from public, anon, authenticated;

create or replace view private.stock_weight_quality_alerts
with (security_invoker = true)
as
select
  snapshot.visit_id,
  visit.client_id,
  visit.seller_id,
  line ->> 'brand' as brand,
  line ->> 'model' as model,
  line ->> 'productCode' as product_code,
  (line ->> 'quantity')::integer as quantity,
  line ->> 'unitWeightKg' as assumed_unit_weight_kg,
  snapshot.device_saved_at,
  snapshot.server_saved_at
from api.stock_snapshots snapshot
join api.visits visit on visit.id = snapshot.visit_id
cross join lateral jsonb_array_elements(coalesce(snapshot.details -> 'ownLines', '[]'::jsonb)) line
where line ->> 'weightSource' = 'fallback_15kg';

revoke all on private.stock_weight_quality_alerts from public, anon, authenticated;

reset role;
revoke create on schema private from cirne_visit_executor;
do $ownership$
begin
  execute pg_catalog.format('revoke cirne_visit_executor from %I granted by current_user', current_user);
end
$ownership$;

commit;
