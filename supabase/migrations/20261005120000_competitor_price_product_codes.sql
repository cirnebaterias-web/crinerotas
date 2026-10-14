begin;

do $ownership$
begin
  execute pg_catalog.format('grant cirne_visit_executor to %I with set true granted by current_user', current_user);
end
$ownership$;
grant create on schema private to cirne_visit_executor;
set local role cirne_visit_executor;

alter table api.competitor_prices
  add column product_code text
  check (product_code is null or (
    char_length(product_code) between 1 and 60
    and product_code = btrim(product_code)
  ));

alter function private.apply_visit_competitor_prices_saved(uuid, jsonb)
  rename to apply_visit_competitor_prices_saved_without_product_code;

create function private.apply_visit_competitor_prices_saved(p_device_id uuid, p_command jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_payload jsonb := p_command -> 'payload';
  v_sanitized_command jsonb := p_command;
  v_sanitized_quotations jsonb;
  v_result jsonb;
begin
  if v_payload ->> 'availability' = 'available' then
    if jsonb_typeof(v_payload -> 'quotations') <> 'array'
       or exists (
         select 1
         from jsonb_array_elements(v_payload -> 'quotations') item(value)
         where item.value ? 'productCode'
           and (
             jsonb_typeof(item.value -> 'productCode') <> 'string'
             or char_length(item.value ->> 'productCode') not between 1 and 60
             or item.value ->> 'productCode' <> btrim(item.value ->> 'productCode')
           )
       ) then
      raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED';
    end if;

    select jsonb_agg(item.value - 'productCode' order by item.ordinality)
      into v_sanitized_quotations
    from jsonb_array_elements(v_payload -> 'quotations') with ordinality as item(value, ordinality);

    v_sanitized_command := jsonb_set(
      p_command,
      '{payload,quotations}',
      coalesce(v_sanitized_quotations, '[]'::jsonb),
      false
    );
  end if;

  v_result := private.apply_visit_competitor_prices_saved_without_product_code(
    p_device_id,
    v_sanitized_command
  );

  if v_payload ->> 'availability' = 'available' then
    update api.competitor_prices price
       set product_code = nullif(item.value ->> 'productCode', '')
      from jsonb_array_elements(v_payload -> 'quotations') with ordinality as item(value, ordinality)
     where price.report_id = (v_result ->> 'reportId')::uuid
       and price.ordinal = item.ordinality;
  end if;

  return v_result;
end
$function$;

revoke all on function private.apply_visit_competitor_prices_saved_without_product_code(uuid, jsonb),
  private.apply_visit_competitor_prices_saved(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function private.apply_visit_competitor_prices_saved(uuid, jsonb)
  to cirne_sync_executor;

comment on column api.competitor_prices.product_code is
  'Optional stable catalog identifier. Null preserves quotations created before Story 3.8.';

reset role;
revoke create on schema private from cirne_visit_executor;
do $ownership$
begin
  execute pg_catalog.format('revoke cirne_visit_executor from %I granted by current_user', current_user);
end
$ownership$;

commit;
