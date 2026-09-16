import {
  createRouteDraftRequestSchema,
  publishRouteRequestSchema,
  routeDraftSchema,
  routePublicationSchema,
  routeTodayResponseSchema,
  canonicalRouteSchema,
  reorderRouteExecutionRequestSchema,
  reorderRouteExecutionResultSchema,
  type CanonicalRoute,
  type CreateRouteDraftRequest,
  type PublishRouteRequest,
  type RouteDraft,
  type RouteErrorCode,
  type RoutePublication,
  type RouteTodayResponse,
  type ReorderRouteExecutionRequest,
  type ReorderRouteExecutionResult,
} from '@cirne/contracts';
import { normalizePendingStopOrder, normalizeRouteDraft, toRouteTodayResponse } from '@cirne/domain';

export interface RouteMutationContext {
  requestId: string;
  origin: 'web' | 'pwa' | 'cli';
}

export interface RouteRepository {
  createDraft(command: CreateRouteDraftRequest): Promise<RouteDraft>;
  publish(routeId: string, request: PublishRouteRequest): Promise<RoutePublication>;
  getById(routeId: string): Promise<CanonicalRoute>;
  getForDate(serviceDate: string): Promise<RouteTodayResponse>;
  reorder(
    routeId: string,
    request: ReorderRouteExecutionRequest,
    context: RouteMutationContext,
  ): Promise<ReorderRouteExecutionResult>;
}

export class RouteServiceFailure extends Error {
  constructor(
    public readonly code: RouteErrorCode,
    message: string,
    public readonly recoverable: boolean,
  ) {
    super(message);
  }
}

const publicMessages: Record<RouteErrorCode, string> = {
  AUTH_REQUIRED: 'Autenticação necessária.',
  FORBIDDEN: 'Operação não autorizada.',
  NOT_FOUND: 'Rota não encontrada.',
  VALIDATION_FAILED: 'Rota inválida.',
  VERSION_CONFLICT: 'A versão enviada conflita com o servidor.',
  DEPENDENCY_UNAVAILABLE: 'Serviço de rotas temporariamente indisponível.',
  INTERNAL_ERROR: 'Não foi possível processar a rota agora.',
};

export function publicRouteMessage(code: RouteErrorCode) {
  return publicMessages[code];
}

export async function createRouteDraft(input: CreateRouteDraftRequest, repository: RouteRepository) {
  const parsed = createRouteDraftRequestSchema.safeParse(input);
  if (!parsed.success) {
    throw new RouteServiceFailure('VALIDATION_FAILED', publicRouteMessage('VALIDATION_FAILED'), false);
  }
  const command = normalizeRouteDraft(parsed.data);
  return routeDraftSchema.parse(await repository.createDraft(command));
}

export async function publishRoute(
  routeId: string,
  input: PublishRouteRequest,
  repository: RouteRepository,
) {
  if (!routeDraftSchema.shape.routeId.safeParse(routeId).success) {
    throw new RouteServiceFailure('VALIDATION_FAILED', publicRouteMessage('VALIDATION_FAILED'), false);
  }
  const parsed = publishRouteRequestSchema.safeParse(input);
  if (!parsed.success) {
    throw new RouteServiceFailure('VALIDATION_FAILED', publicRouteMessage('VALIDATION_FAILED'), false);
  }
  const request = parsed.data;
  return routePublicationSchema.parse(await repository.publish(routeId, request));
}

export async function getRoute(routeId: string, repository: RouteRepository) {
  if (!routeDraftSchema.shape.routeId.safeParse(routeId).success) {
    throw new RouteServiceFailure('VALIDATION_FAILED', publicRouteMessage('VALIDATION_FAILED'), false);
  }
  return canonicalRouteSchema.parse(await repository.getById(routeId));
}

export async function reorderRouteExecution(
  routeId: string,
  input: ReorderRouteExecutionRequest,
  context: RouteMutationContext,
  repository: RouteRepository,
) {
  if (!routeDraftSchema.shape.routeId.safeParse(routeId).success) {
    throw new RouteServiceFailure('VALIDATION_FAILED', publicRouteMessage('VALIDATION_FAILED'), false);
  }
  const parsed = reorderRouteExecutionRequestSchema.safeParse(input);
  if (!parsed.success) {
    throw new RouteServiceFailure('VALIDATION_FAILED', publicRouteMessage('VALIDATION_FAILED'), false);
  }
  const command = normalizePendingStopOrder(parsed.data);
  return reorderRouteExecutionResultSchema.parse(await repository.reorder(routeId, command, context));
}

export async function getMyRouteForDate(serviceDate: string, repository: RouteRepository) {
  const parsedDate = createRouteDraftRequestSchema.shape.serviceDate.safeParse(serviceDate);
  if (!parsedDate.success) {
    throw new RouteServiceFailure('VALIDATION_FAILED', publicRouteMessage('VALIDATION_FAILED'), false);
  }
  const response = routeTodayResponseSchema.parse(await repository.getForDate(parsedDate.data));
  return toRouteTodayResponse(
    response.availability === 'available' ? response.route : null,
    parsedDate.data,
  );
}
