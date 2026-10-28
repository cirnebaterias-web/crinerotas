import {
  visitErrorCodeSchema,
  competitorPricesResultSchema,
  competitorPriceParameterSetSchema,
  visitStartResultSchema,
  stockSnapshotResultSchema,
  visitDetailResponseSchema,
  attachmentDownloadUrlResponseSchema,
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
  type VisitDetailRepository,
  type VisitAttachmentDownloadRepository,
} from './service';
import { z } from 'zod';

const authorizedAttachmentSchema = z.object({
  bucket: z.enum(['visit-evidence', 'scrap-evidence']),
  storagePath: z.string().trim().min(1).max(500),
  expiresInSeconds: z.literal(60),
}).strict();

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
  VisitCompetitorPricesRepository, CompetitorPriceParametersRepository, VisitDetailRepository,
  VisitAttachmentDownloadRepository {
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

  async getDetail(visitId: string, requestId: string) {
    let response: { data: unknown; error: { message: string } | null };
    try {
      response = await this.client.schema('api').rpc('get_visit_detail', {
        p_visit_id: visitId, p_request_id: requestId, p_origin: 'web',
      }).abortSignal(AbortSignal.timeout(10_000));
    } catch {
      throw unavailable();
    }
    if (response.error) throw mapDatabaseFailure(response.error.message);
    const parsed = visitDetailResponseSchema.safeParse(response.data);
    if (!parsed.success) throw unavailable();
    return parsed.data;
  }

  async createDownloadUrl(attachmentId: string, requestId: string) {
    let response: { data: unknown; error: { message: string } | null };
    try {
      response = await this.client.schema('api').rpc('authorize_visit_attachment_download', {
        p_attachment_id: attachmentId, p_request_id: requestId, p_origin: 'web',
      }).abortSignal(AbortSignal.timeout(10_000));
    } catch {
      throw unavailable();
    }
    if (response.error) throw mapDatabaseFailure(response.error.message);
    const authorization = authorizedAttachmentSchema.safeParse(response.data);
    if (!authorization.success) throw unavailable();
    let signed: Awaited<ReturnType<ReturnType<typeof this.client.storage.from>['createSignedUrl']>>;
    try {
      signed = await this.client.storage.from(authorization.data.bucket)
        .createSignedUrl(authorization.data.storagePath, authorization.data.expiresInSeconds);
    } catch {
      throw unavailable();
    }
    if (signed.error || !signed.data?.signedUrl) throw unavailable();
    return attachmentDownloadUrlResponseSchema.parse({
      schemaVersion: 1,
      attachmentId,
      url: signed.data.signedUrl,
      expiresInSeconds: authorization.data.expiresInSeconds,
    });
  }
}
