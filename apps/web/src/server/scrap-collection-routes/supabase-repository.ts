import type { SupabaseClient } from '@supabase/supabase-js';
import { scrapRpc } from '../scrap/http';
import type { ScrapCollectionRouteRepository } from './service';

export class SupabaseScrapCollectionRouteRepository implements ScrapCollectionRouteRepository {
  constructor(private readonly client: SupabaseClient) {}
  list(date: string) { return scrapRpc(this.client, 'list_scrap_collection_routes', { p_date: date }); }
  get(routeId: string) { return scrapRpc(this.client, 'get_scrap_collection_route', { p_route_id: routeId }); }
  create(idempotencyKey: string, command: unknown) {
    return scrapRpc(this.client, 'create_scrap_collection_route', {
      p_idempotency_key: idempotencyKey, p_command: command,
    });
  }
  change(...[routeId, operation, idempotencyKey, command]: Parameters<ScrapCollectionRouteRepository['change']>) {
    return scrapRpc(this.client, 'change_scrap_collection_route', {
      p_route_id: routeId, p_operation: operation, p_idempotency_key: idempotencyKey, p_command: command,
    });
  }
}
