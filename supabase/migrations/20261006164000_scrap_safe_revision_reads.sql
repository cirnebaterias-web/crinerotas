-- Story 3.10: expose only business fields from immutable correction history.
begin;
do $membership$ begin execute format('grant cirne_scrap_executor to %I with set true granted by current_user',current_user); end $membership$;
grant create on schema api,private to cirne_scrap_executor;
set local role cirne_scrap_executor;
-- BEGIN projection function
create or replace function private.scrap_revision_projection(p_snapshot jsonb) returns jsonb language sql immutable set search_path='' as $$
select jsonb_strip_nulls(jsonb_build_object('actualWeightKg',p_snapshot->'actualWeightKg','collectedAt',p_snapshot->'collectedAt',
'receiptNumber',p_snapshot->'receiptNumber','destinationType',p_snapshot->'destinationType','concentrationPoint',p_snapshot->'concentrationPoint',
'receivedWeightKg',p_snapshot#>'{receipt,receivedWeightKg}','receivedLocation',p_snapshot#>'{receipt,receivedLocation}',
'observation',p_snapshot#>'{receipt,observation}','receivedBy',p_snapshot#>'{receipt,receivedBy}','receivedAt',p_snapshot#>'{receipt,receivedAt}',
'status',p_snapshot->'status','version',p_snapshot->'version','retentionUntil',p_snapshot->'retentionUntil')); $$;
-- END projection function
create function api.list_scrap_collection_revisions(p_collection_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare d jsonb:=private.scrap_identity('scrap.read_operations'); c api.scrap_collections%rowtype; begin
select * into c from api.scrap_collections where id=p_collection_id;
if not found or not private.scrap_visible(c.seller_id) then raise exception using errcode='P0001',message='NOT_FOUND'; end if;
return coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'kind',r.kind,'reason',r.reason,
'actor',jsonb_build_object('id',r.actor_id,'displayName',p.display_name),'changedAt',r.created_at,
'before',private.scrap_revision_projection(r.before_data),'after',private.scrap_revision_projection(r.after_data)) order by r.created_at,r.id)
from api.scrap_corrections r join api.user_profiles p on p.id=r.actor_id where r.collection_id=c.id),'[]'); end $$;
revoke all on function private.scrap_revision_projection(jsonb) from public,anon,authenticated;
revoke all on function api.list_scrap_collection_revisions(uuid) from public,anon;
grant execute on function api.list_scrap_collection_revisions(uuid) to authenticated;
reset role;
revoke create on schema api,private from cirne_scrap_executor;
do $membership$ begin execute format('revoke cirne_scrap_executor from %I granted by current_user',current_user); end $membership$;
commit;
