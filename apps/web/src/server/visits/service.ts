import {
  startVisitRequestSchema,
  competitorPricesResultSchema,
  competitorPriceParameterSetSchema,
  saveCompetitorPricesRequestSchema,
  saveStockRequestSchema,
  stockSnapshotResultSchema,
  visitStartResultSchema,
  visitDetailResponseSchema,
  attachmentDownloadUrlResponseSchema,
  type CompetitorPriceParameterSet,
  type CompetitorPricesResult,
  type SaveCompetitorPricesRequest,
  type StartVisitRequest,
  type SaveStockRequest,
  type StockSnapshotResult,
  type VisitErrorCode,
  type VisitStartResult,
  type VisitDetailResponse,
  type AttachmentDownloadUrlResponse,
  type MeResponse,
} from '@cirne/contracts';
import { normalizeVisitStart } from '@cirne/domain';

export interface VisitStartRepository {
  start(
    deviceId: string,
    idempotencyKey: string,
    command: StartVisitRequest,
  ): Promise<VisitStartResult>;
}

/** Compatibility alias for the visit-start tests and adapters from Story 3.1. */
export type VisitRepository = VisitStartRepository;

export interface VisitStockRepository {
  saveStock(
    deviceId: string,
    idempotencyKey: string,
    command: SaveStockRequest,
  ): Promise<StockSnapshotResult>;
}

export interface VisitCompetitorPricesRepository {
  saveCompetitorPrices(
    deviceId: string,
    idempotencyKey: string,
    command: SaveCompetitorPricesRequest,
  ): Promise<CompetitorPricesResult>;
}

export interface CompetitorPriceParametersRepository {
  getCurrentCompetitorPriceParameters(at: string): Promise<CompetitorPriceParameterSet>;
}

export interface VisitDetailRepository {
  getDetail(visitId: string, requestId: string): Promise<VisitDetailResponse>;
}

export interface VisitAttachmentDownloadRepository {
  createDownloadUrl(attachmentId: string, requestId: string): Promise<AttachmentDownloadUrlResponse>;
}

export class VisitServiceFailure extends Error {
  constructor(
    public readonly code: VisitErrorCode,
    message: string,
    public readonly recoverable: boolean,
  ) {
    super(message);
  }
}

const publicMessages: Record<VisitErrorCode, string> = {
  AUTH_REQUIRED: 'Autenticação necessária.',
  FORBIDDEN: 'Visita não encontrada ou indisponível.',
  NOT_FOUND: 'Visita não encontrada ou indisponível.',
  VALIDATION_FAILED: 'Início de visita inválido.',
  VERSION_CONFLICT: 'A parada não está disponível para iniciar.',
  EVENT_OUT_OF_ORDER: 'O início da visita ainda não foi confirmado.',
  IDEMPOTENCY_KEY_REUSED: 'A chave de idempotência já foi usada com outro conteúdo.',
  DEPENDENCY_UNAVAILABLE: 'Serviço de visitas temporariamente indisponível.',
  INTERNAL_ERROR: 'Não foi possível iniciar a visita agora.',
};

export function publicVisitMessage(code: VisitErrorCode) {
  return publicMessages[code];
}

export function requireVisitDetailAccess(identity: MeResponse) {
  if (!identity.roles.includes('manager') ||
      !identity.capabilities.includes('route.read_scoped') ||
      identity.scopeIds.length === 0) {
    throw new VisitServiceFailure('FORBIDDEN', publicVisitMessage('FORBIDDEN'), false);
  }
}

export async function getVisitDetail(
  identity: MeResponse,
  visitId: string,
  requestId: string,
  repository: VisitDetailRepository,
) {
  requireVisitDetailAccess(identity);
  const parsedVisitId = startVisitRequestSchema.shape.offlineId.safeParse(visitId);
  const parsedRequestId = startVisitRequestSchema.shape.offlineId.safeParse(requestId);
  if (!parsedVisitId.success || !parsedRequestId.success) {
    throw new VisitServiceFailure('VALIDATION_FAILED', 'Identificador de visita inválido.', false);
  }
  const result = visitDetailResponseSchema.safeParse(await repository.getDetail(parsedVisitId.data, parsedRequestId.data));
  if (!result.success || result.data.visitId !== parsedVisitId.data) {
    throw new VisitServiceFailure('DEPENDENCY_UNAVAILABLE', publicVisitMessage('DEPENDENCY_UNAVAILABLE'), true);
  }
  return result.data;
}

export async function createVisitAttachmentDownloadUrl(
  identity: MeResponse,
  attachmentId: string,
  requestId: string,
  repository: VisitAttachmentDownloadRepository,
) {
  requireVisitDetailAccess(identity);
  if (!identity.capabilities.includes('visit.evidence.read_scoped')) {
    throw new VisitServiceFailure('NOT_FOUND', publicVisitMessage('NOT_FOUND'), false);
  }
  const parsedAttachmentId = startVisitRequestSchema.shape.offlineId.safeParse(attachmentId);
  const parsedRequestId = startVisitRequestSchema.shape.offlineId.safeParse(requestId);
  if (!parsedAttachmentId.success || !parsedRequestId.success) {
    throw new VisitServiceFailure('VALIDATION_FAILED', 'Identificador de evidência inválido.', false);
  }
  const result = attachmentDownloadUrlResponseSchema.safeParse(
    await repository.createDownloadUrl(parsedAttachmentId.data, parsedRequestId.data),
  );
  if (!result.success || result.data.attachmentId !== parsedAttachmentId.data) {
    throw new VisitServiceFailure('DEPENDENCY_UNAVAILABLE', publicVisitMessage('DEPENDENCY_UNAVAILABLE'), true);
  }
  return result.data;
}

export async function saveVisitStock(
  offlineId: string,
  deviceId: string,
  idempotencyKey: string,
  input: SaveStockRequest,
  repository: VisitStockRepository,
) {
  const parsedOfflineId = startVisitRequestSchema.shape.offlineId.safeParse(offlineId);
  const parsedDevice = startVisitRequestSchema.shape.offlineId.safeParse(deviceId);
  const parsedKey = startVisitRequestSchema.shape.offlineId.safeParse(idempotencyKey);
  const parsed = saveStockRequestSchema.safeParse(input);
  if (!parsedOfflineId.success || !parsedDevice.success || !parsedKey.success || !parsed.success ||
      parsed.data.offlineId !== parsedOfflineId.data) {
    throw new VisitServiceFailure('VALIDATION_FAILED', publicVisitMessage('VALIDATION_FAILED'), false);
  }
  const result = stockSnapshotResultSchema.safeParse(await repository.saveStock(
    parsedDevice.data,
    parsedKey.data,
    parsed.data,
  ));
  if (!result.success || result.data.offlineId !== parsed.data.offlineId ||
      result.data.heliarQuantity !== parsed.data.heliarQuantity ||
      result.data.mouraQuantity !== parsed.data.mouraQuantity ||
      result.data.observation !== parsed.data.observation) {
    throw new VisitServiceFailure('DEPENDENCY_UNAVAILABLE', publicVisitMessage('DEPENDENCY_UNAVAILABLE'), true);
  }
  return result.data;
}

export async function saveVisitCompetitorPrices(
  offlineId: string,
  deviceId: string,
  idempotencyKey: string,
  input: SaveCompetitorPricesRequest,
  repository: VisitCompetitorPricesRepository,
) {
  const parsedOfflineId = startVisitRequestSchema.shape.offlineId.safeParse(offlineId);
  const parsedDevice = startVisitRequestSchema.shape.offlineId.safeParse(deviceId);
  const parsedKey = startVisitRequestSchema.shape.offlineId.safeParse(idempotencyKey);
  const parsed = saveCompetitorPricesRequestSchema.safeParse(input);
  if (!parsedOfflineId.success || !parsedDevice.success || !parsedKey.success || !parsed.success ||
      parsed.data.offlineId !== parsedOfflineId.data) {
    throw new VisitServiceFailure('VALIDATION_FAILED', publicVisitMessage('VALIDATION_FAILED'), false);
  }
  const result = competitorPricesResultSchema.safeParse(await repository.saveCompetitorPrices(
    parsedDevice.data,
    parsedKey.data,
    parsed.data,
  ));
  if (!result.success || result.data.offlineId !== parsed.data.offlineId ||
      result.data.availability !== parsed.data.availability ||
      (parsed.data.availability === 'available' &&
        result.data.quotationIds.length !== parsed.data.quotations.length) ||
      (parsed.data.availability === 'unavailable' &&
        result.data.unavailableReasonId !== parsed.data.unavailableReasonId)) {
    throw new VisitServiceFailure('DEPENDENCY_UNAVAILABLE', publicVisitMessage('DEPENDENCY_UNAVAILABLE'), true);
  }
  return result.data;
}

export async function getCurrentCompetitorPriceParameters(
  at: string,
  repository: CompetitorPriceParametersRepository,
) {
  const parsedAt = startVisitRequestSchema.shape.deviceStartedAt.safeParse(at);
  if (!parsedAt.success) {
    throw new VisitServiceFailure('VALIDATION_FAILED', publicVisitMessage('VALIDATION_FAILED'), false);
  }
  const result = competitorPriceParameterSetSchema.safeParse(
    await repository.getCurrentCompetitorPriceParameters(parsedAt.data),
  );
  if (!result.success || Date.parse(result.data.validFrom) > Date.parse(parsedAt.data)) {
    throw new VisitServiceFailure('DEPENDENCY_UNAVAILABLE', publicVisitMessage('DEPENDENCY_UNAVAILABLE'), true);
  }
  return result.data;
}

export async function startVisit(
  deviceId: string,
  idempotencyKey: string,
  input: StartVisitRequest,
  repository: VisitStartRepository,
) {
  const parsedDevice = startVisitRequestSchema.shape.offlineId.safeParse(deviceId);
  const parsedKey = startVisitRequestSchema.shape.offlineId.safeParse(idempotencyKey);
  const parsed = startVisitRequestSchema.safeParse(input);
  if (!parsedDevice.success || !parsedKey.success || !parsed.success) {
    throw new VisitServiceFailure('VALIDATION_FAILED', publicVisitMessage('VALIDATION_FAILED'), false);
  }
  const command = normalizeVisitStart(parsed.data);
  const result = visitStartResultSchema.safeParse(await repository.start(
    parsedDevice.data,
    parsedKey.data,
    command,
  ));
  if (!result.success || result.data.deviceId !== parsedDevice.data ||
      result.data.offlineId !== command.offlineId ||
      result.data.routeVersionStopId !== command.routeVersionStopId ||
      Date.parse(result.data.deviceStartedAt) !== Date.parse(command.deviceStartedAt)) {
    throw new VisitServiceFailure(
      'DEPENDENCY_UNAVAILABLE',
      publicVisitMessage('DEPENDENCY_UNAVAILABLE'),
      true,
    );
  }
  return result.data;
}
