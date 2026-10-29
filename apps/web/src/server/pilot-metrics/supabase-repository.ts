import { z } from 'zod';
import { pilotMetricDrilldownSchema, type RouteErrorCode } from '@cirne/contracts';
import type { SupabaseClient } from '@supabase/supabase-js';
import { publicRouteMessage, RouteServiceFailure } from '../routes/service';
import type { PilotMetricsRepository } from './service';

const projectionSchema = z.object({
  generatedAt: z.iso.datetime({ offset: true }),
  lastServerConfirmedAt: z.iso.datetime({ offset: true }).nullable(),
  totals: z.object({
    completed: z.number().int().nonnegative(), requiredComplete: z.number().int().nonnegative(),
    scrapReported: z.number().int().nonnegative(), commercialActionReported: z.number().int().nonnegative(),
    syncWithin24h: z.number().int().nonnegative(), syncEligible: z.number().int().nonnegative(),
    windowOpen: z.number().int().nonnegative(), clockSuspicious: z.number().int().nonnegative(),
  }).strict(),
  records: z.array(pilotMetricDrilldownSchema).max(50),
  nextCursor: z.string().regex(/^[A-Za-z0-9_-]{8,1024}$/u).nullable(),
}).strict();

const knownDatabaseCodes = new Set<RouteErrorCode>(['FORBIDDEN', 'VALIDATION_FAILED']);

export class SupabasePilotMetricsRepository implements PilotMetricsRepository {
  constructor(private readonly client: SupabaseClient) {}

  async get(filters: Parameters<PilotMetricsRepository['get']>[0], operationalTimeZone: string) {
    let result: { data: unknown; error: { message?: string } | null };
    try {
      result = await this.client.schema('api').rpc('get_pilot_metrics', {
        p_from: filters.from, p_to: filters.to,
        p_seller_id: filters.sellerId ?? null, p_client_id: filters.clientId ?? null,
        p_cursor: filters.cursor ?? null, p_operational_time_zone: operationalTimeZone,
      }).abortSignal(AbortSignal.timeout(10_000));
    } catch {
      throw new RouteServiceFailure('DEPENDENCY_UNAVAILABLE', publicRouteMessage('DEPENDENCY_UNAVAILABLE'), true);
    }
    if (result.error) {
      const code = knownDatabaseCodes.has(result.error.message as RouteErrorCode)
        ? result.error.message as RouteErrorCode : 'DEPENDENCY_UNAVAILABLE';
      throw new RouteServiceFailure(code, publicRouteMessage(code), code === 'DEPENDENCY_UNAVAILABLE');
    }
    const parsed = projectionSchema.safeParse(result.data);
    if (!parsed.success) {
      throw new RouteServiceFailure('DEPENDENCY_UNAVAILABLE', publicRouteMessage('DEPENDENCY_UNAVAILABLE'), true);
    }
    return parsed.data;
  }
}
