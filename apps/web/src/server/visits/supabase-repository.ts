import {
  visitErrorCodeSchema,
  competitorPricesResultSchema,
  competitorPriceParameterSetSchema,
  visitStartResultSchema,
  stockSnapshotResultSchema,
  type SaveCompetitorPricesRequest,
  type StartVisitRequest,
  type SaveStockRequest,
  type VisitErrorCode,
} from '@cirne/contracts';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  publicVisitMessage,
  VisitServiceFailure,
  type VisitStartRepository,
  type CompetitorPriceParametersRepository,
  type VisitCompetitorPricesRepository,
  type VisitStockRepository,
} from './service';

function unavailable() {
  return new VisitServiceFailure(
    'DEPENDENCY_UNAVAILABLE',
    publicVisitMessage('DEPENDENCY_UNAVAILABLE'),
    true,
  );
}

function mapDatabaseFailure(message: string) {
  const parsed = visitErrorCodeSchema.safeParse(message);
  const code: VisitErrorCode = parsed.success ? parsed.data : 'DEPENDENCY_UNAVAILABLE';
  return new VisitServiceFailure(
    code,
    publicVisitMessage(code),
    code === 'DEPENDENCY_UNAVAILABLE' || code === 'INTERNAL_ERROR',
  );
}

export class SupabaseVisitRepository implements VisitStartRepository, VisitStockRepository,
  VisitCompetitorPricesRepository, CompetitorPriceParametersRepository {
  constructor(private readonly client: SupabaseClient) {}

  async start(deviceId: string, idempotencyKey: string, command: StartVisitRequest) {
    let response: { data: unknown; error: { message: string } | null };
    try {
      response = await this.client.schema('api').rpc('start_visit', {
        p_device_id: deviceId,
        p_idempotency_key: idempotencyKey,
        p_command: command,
      }).abortSignal(AbortSignal.timeout(30_000));
    } catch {
      throw unavailable();
    }
    const { data, error } = response;
    if (error) throw mapDatabaseFailure(error.message);
    const parsed = visitStartResultSchema.safeParse(data);
    if (!parsed.success) throw unavailable();
    return parsed.data;
  }

  async saveStock(deviceId: string, idempotencyKey: string, command: SaveStockRequest) {
    let response: { data: unknown; error: { message: string } | null };
    try {
      response = await this.client.schema('api').rpc('save_visit_stock', {
        p_device_id: deviceId,
        p_idempotency_key: idempotencyKey,
        p_command: command,
      }).abortSignal(AbortSignal.timeout(30_000));
    } catch {
      throw unavailable();
    }
    const { data, error } = response;
    if (error) throw mapDatabaseFailure(error.message);
    const parsed = stockSnapshotResultSchema.safeParse(data);
    if (!parsed.success) throw unavailable();
    return parsed.data;
  }

  async saveCompetitorPrices(
    deviceId: string,
    idempotencyKey: string,
    command: SaveCompetitorPricesRequest,
  ) {
    let response: { data: unknown; error: { message: string } | null };
    try {
      response = await this.client.schema('api').rpc('save_visit_competitor_prices', {
        p_device_id: deviceId,
        p_idempotency_key: idempotencyKey,
        p_command: command,
      }).abortSignal(AbortSignal.timeout(30_000));
    } catch {
      throw unavailable();
    }
    const { data, error } = response;
    if (error) throw mapDatabaseFailure(error.message);
    const parsed = competitorPricesResultSchema.safeParse(data);
    if (!parsed.success) throw unavailable();
    return parsed.data;
  }

  async getCurrentCompetitorPriceParameters(at: string) {
    let response: { data: unknown; error: { message: string } | null };
    try {
      response = await this.client.schema('api').rpc('get_current_competitor_price_parameters', {
        p_at: at,
      }).abortSignal(AbortSignal.timeout(30_000));
    } catch {
      throw unavailable();
    }
    const { data, error } = response;
    if (error) throw mapDatabaseFailure(error.message);
    const parsed = competitorPriceParameterSetSchema.safeParse(data);
    if (!parsed.success) throw unavailable();
    return parsed.data;
  }
}
