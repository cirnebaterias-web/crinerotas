import { randomUUID } from 'node:crypto';
import type { MeResponse } from '@cirne/contracts';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  enforceRouteCookieCsrf, logRouteRequest, mapRouteRequestError, resolveRouteRequest,
  routeErrorResponse, routeResponseHeaders, RouteRequestError,
} from '../routes/http';

export function requireClientCapability(identity: MeResponse, capability: 'clients.read' | 'clients.import') {
  if (!identity.capabilities.includes(capability)) {
    throw new RouteRequestError(403, 'FORBIDDEN', 'Operação não autorizada.', false);
  }
}
export async function clientImportRpc(client: SupabaseClient, name: string, args: Record<string, unknown> = {}) {
  const { data, error } = await client.schema('api').rpc(name, args).abortSignal(AbortSignal.timeout(30_000));
  if (!error) return data as unknown;
  const statuses = { AUTH_REQUIRED: 401, FORBIDDEN: 403, NOT_FOUND: 404,
    VERSION_CONFLICT: 409, VALIDATION_FAILED: 422 } as const;
  if (error.code === 'P0001' && error.message in statuses) {
    const code = error.message as keyof typeof statuses;
    throw new RouteRequestError(statuses[code], code, code === 'FORBIDDEN' ? 'Operação não autorizada.' :
      'Não foi possível processar a base de clientes.', false);
  }
  throw new RouteRequestError(503, 'DEPENDENCY_UNAVAILABLE', 'Base de clientes temporariamente indisponível.', true);
}

export async function handleClientImportRequest(request: Request, routeTemplate: string,
  operation: (context: Awaited<ReturnType<typeof resolveRouteRequest>>, headers: Headers) => Promise<Response>) {
  const requestId = randomUUID();
  const headers = routeResponseHeaders(requestId);
  const startedAt = performance.now();
  let response: Response;
  try {
    if (request.method !== 'GET') enforceRouteCookieCsrf(request);
    response = await operation(await resolveRouteRequest(request, headers), headers);
  } catch (error) {
    response = routeErrorResponse(mapRouteRequestError(error), requestId, headers);
  }
  logRouteRequest({ requestId, routeTemplate, method: request.method, status: response.status, startedAt });
  return response;
}
