import type { SupabaseClient } from '@supabase/supabase-js';
import { scrapRpc } from '@/server/scrap/http';
import type { LogisticsPickupRepository } from './service';

export class SupabaseLogisticsPickupRepository implements LogisticsPickupRepository {
  constructor(private readonly client: SupabaseClient) {}
  list(date: string) { return scrapRpc(this.client, 'list_logistics_pickups', { p_date: date }); }
  operators() { return scrapRpc(this.client, 'list_logistics_operators'); }
  change(...[scheduleId, operation, idempotencyKey, command]: Parameters<LogisticsPickupRepository['change']>) {
    return scrapRpc(this.client, 'change_logistics_pickup', {
      p_schedule_id: scheduleId, p_operation: operation, p_idempotency_key: idempotencyKey, p_command: command,
    });
  }
}
