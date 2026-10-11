import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { MeResponse } from '@cirne/contracts';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  enforceRouteCookieCsrf, mapRouteRequestError, resolveRouteRequest,
  routeErrorResponse, routeResponseHeaders, RouteRequestError, logRouteRequest,
} from '../routes/http';

export function requireScrapAccess(identity: MeResponse, capability: string) {
  if (!identity.capabilities.includes(capability)) {
    throw new RouteRequestError(403, 'FORBIDDEN', 'Operação não autorizada.', false);
  }
}

export function mutationHeaders(request: Request, deviceRequired = true) {
  const idempotencyKey = z.uuid().safeParse(request.headers.get('idempotency-key'));
  const deviceId = z.uuid().safeParse(request.headers.get('x-device-id'));
  if (!idempotencyKey.success || (deviceRequired && !deviceId.success)) {
    throw new RouteRequestError(422, 'VALIDATION_FAILED', 'Identificação da operação inválida.', false);
  }
  return { idempotencyKey: idempotencyKey.data, deviceId: deviceId.success ? deviceId.data : '' };
}

export function parseScrap<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new RouteRequestError(422, 'VALIDATION_FAILED', 'Revise os dados da sucata.', false);
  return parsed.data;
}

export async function scrapRpc(client: SupabaseClient, name: string, args: Record<string, unknown> = {}) {
  try {
    const { data, error } = await client.schema('api').rpc(name, args).abortSignal(AbortSignal.timeout(30_000));
    if (error) {
      if (error.code === 'P0001' && error.message === 'ATTACHMENT_NOT_VERIFIED') {
        throw new RouteRequestError(422, 'VALIDATION_FAILED', 'Aguarde a verificação dos comprovantes antes de receber a sucata.', false);
      }
      const statuses = { AUTH_REQUIRED: 401, FORBIDDEN: 403, NOT_FOUND: 404,
        VERSION_CONFLICT: 409, IDEMPOTENCY_KEY_REUSED: 409, VALIDATION_FAILED: 422 } as const;
      if (error.code === 'P0001' && error.message in statuses) {
        const code = error.message as keyof typeof statuses;
        throw new RouteRequestError(statuses[code], code === 'IDEMPOTENCY_KEY_REUSED' ? 'VERSION_CONFLICT' : code,
          code === 'FORBIDDEN' ? 'Operação não autorizada.' : 'Não foi possível concluir a operação de sucata.', false);
      }
      throw new RouteRequestError(503, 'DEPENDENCY_UNAVAILABLE', 'Sucata temporariamente indisponível.', true);
    }
    return data as unknown;
  } catch (error) {
    if (error instanceof RouteRequestError) throw error;
    throw new RouteRequestError(503, 'DEPENDENCY_UNAVAILABLE', 'Sucata temporariamente indisponível.', true);
  }
}

export function scrapResponse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new RouteRequestError(503, 'DEPENDENCY_UNAVAILABLE', 'Sucata temporariamente indisponível.', true);
  return parsed.data;
}

export async function handleScrapRequest(request: Request, routeTemplate: string,
  operation: (context: Awaited<ReturnType<typeof resolveRouteRequest>>, headers: Headers) => Promise<Response>) {
  const requestId = randomUUID();
  const headers = routeResponseHeaders(requestId);
  const startedAt = performance.now();
  let response: Response;
  try {
    if (request.method !== 'GET') enforceRouteCookieCsrf(request);
    const context = await resolveRouteRequest(request, headers);
    response = await operation(context, headers);
  } catch (error) {
    response = routeErrorResponse(mapRouteRequestError(error), requestId, headers);
  }
  logRouteRequest({ requestId, routeTemplate, method: request.method, status: response.status, startedAt });
  return response;
}
