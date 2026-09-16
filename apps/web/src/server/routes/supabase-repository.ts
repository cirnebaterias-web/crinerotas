import {
  canonicalRouteSchema,
  routeDraftSchema,
  routeErrorCodeSchema,
  routePublicationSchema,
  routeTodayResponseSchema,
  reorderRouteExecutionResultSchema,
  type CreateRouteDraftRequest,
  type PublishRouteRequest,
  type RouteErrorCode,
  type ReorderRouteExecutionRequest,
} from '@cirne/contracts';
import type { SupabaseClient } from '@supabase/supabase-js';
import { publicRouteMessage, RouteServiceFailure, type RouteRepository } from './service';

const databaseErrorCodes = new Set<RouteErrorCode>(routeErrorCodeSchema.options);

function mapDatabaseFailure(message: string) {
  const code = databaseErrorCodes.has(message as RouteErrorCode)
    ? message as RouteErrorCode
    : 'DEPENDENCY_UNAVAILABLE';
  return new RouteServiceFailure(
    code,
    publicRouteMessage(code),
    code === 'DEPENDENCY_UNAVAILABLE' || code === 'INTERNAL_ERROR',
  );
}

function unavailable() {
  return new RouteServiceFailure(
    'DEPENDENCY_UNAVAILABLE',
    publicRouteMessage('DEPENDENCY_UNAVAILABLE'),
    true,
  );
}

async function resolveRpc<T>(request: PromiseLike<T>): Promise<T> {
  try {
    return await request;
  } catch {
    throw unavailable();
  }
}

export class SupabaseRouteRepository implements RouteRepository {
  constructor(private readonly client: SupabaseClient) {}

  async createDraft(command: CreateRouteDraftRequest) {
    const { data, error } = await resolveRpc(this.client.schema('api').rpc('create_route_draft', {
      p_command: command,
    }).abortSignal(AbortSignal.timeout(30_000)));
    if (error) throw mapDatabaseFailure(error.message);
    const parsed = routeDraftSchema.safeParse(data);
    const requestedStops = new Map(command.stops.map((stop) => [stop.clientId, stop]));
    const returnedClientIds = parsed.success
      ? new Set(parsed.data.stops.map((stop) => stop.clientId))
      : new Set<string>();
    if (!parsed.success || parsed.data.sellerId !== command.sellerId ||
        parsed.data.serviceDate !== command.serviceDate || parsed.data.stops.length !== requestedStops.size ||
        returnedClientIds.size !== requestedStops.size ||
        parsed.data.stops.some((stop) => {
          const requested = requestedStops.get(stop.clientId);
          return !requested || requested.plannedOrder !== stop.plannedOrder || requested.priority !== stop.priority;
        })) {
      throw unavailable();
    }
    return parsed.data;
  }

  async publish(routeId: string, request: PublishRouteRequest) {
    const { data, error } = await resolveRpc(this.client.schema('api').rpc('publish_route', {
      p_route_id: routeId,
      p_expected_version: request.expectedVersion,
    }).abortSignal(AbortSignal.timeout(30_000)));
    if (error) throw mapDatabaseFailure(error.message);
    const parsed = routePublicationSchema.safeParse(data);
    if (!parsed.success || parsed.data.routeId !== routeId ||
        parsed.data.expectedVersion !== request.expectedVersion + 1) {
      throw unavailable();
    }
    return parsed.data;
  }

  async getById(routeId: string) {
    const { data, error } = await resolveRpc(this.client.schema('api').rpc('get_route', {
      p_route_id: routeId,
    }).abortSignal(AbortSignal.timeout(10_000)));
    if (error) throw mapDatabaseFailure(error.message);
    const parsed = canonicalRouteSchema.safeParse(data);
    if (!parsed.success || parsed.data.routeId !== routeId) throw unavailable();
    return parsed.data;
  }

  async getForDate(serviceDate: string) {
    const { data, error } = await resolveRpc(this.client.schema('api').rpc('get_my_route_for_date', {
      p_service_date: serviceDate,
    }).abortSignal(AbortSignal.timeout(10_000)));
    if (error) throw mapDatabaseFailure(error.message);
    const parsed = routeTodayResponseSchema.safeParse(data);
    if (!parsed.success || (parsed.data.availability === 'empty'
      ? parsed.data.serviceDate !== serviceDate
      : parsed.data.route.serviceDate !== serviceDate)) {
      throw unavailable();
    }
    return parsed.data;
  }

  async reorder(
    routeId: string,
    request: ReorderRouteExecutionRequest,
    context: { requestId: string; origin: 'web' | 'pwa' | 'cli' },
  ) {
    const { data, error } = await resolveRpc(this.client.schema('api').rpc('reorder_route_execution', {
      p_route_id: routeId,
      p_command: request,
      p_request_id: context.requestId,
      p_origin: context.origin,
    }).abortSignal(AbortSignal.timeout(30_000)));
    if (error) throw mapDatabaseFailure(error.message);
    const parsed = reorderRouteExecutionResultSchema.safeParse(data);
    if (!parsed.success || parsed.data.routeId !== routeId ||
        parsed.data.executionVersion !== request.expectedVersion + (parsed.data.changed ? 1 : 0) ||
        parsed.data.pendingStopIds.length !== request.pendingStopIds.length ||
        parsed.data.pendingStopIds.some((stopId, index) => stopId !== request.pendingStopIds[index])) {
      throw unavailable();
    }
    return parsed.data;
  }
}
