import { cookies } from 'next/headers';
import type { CookieMethodsServer, CookieOptions } from '@supabase/ssr';
import { apiErrorResponseSchema, type RouteErrorCode } from '@cirne/contracts';
import { readServerConfig } from '@cirne/config/server';
import {
  createCallerScopedClient,
  IdentityRequestError,
  parseBearer,
  resolveIdentityRequest,
} from '../identity';
import { createLogger, logRequest } from '../logging';
import { publicRouteMessage, RouteServiceFailure } from './service';

const maxRouteBodyBytes = 64 * 1024;
const routeCsrfHeaderValue = 'cirne-route-v1';

export class RouteRequestError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 500 | 503,
    public readonly code: RouteErrorCode,
    message: string,
    public readonly recoverable: boolean,
  ) {
    super(message);
  }
}

export function routeResponseHeaders(requestId: string) {
  return new Headers({
    'Cache-Control': 'private, no-cache, no-store, must-revalidate, max-age=0',
    'X-Request-Id': requestId,
  });
}

export function enforceRouteCookieCsrf(request: Request) {
  if (parseBearer(request.headers.get('authorization'))) return;
  let appOrigin: string;
  try {
    appOrigin = new URL(readServerConfig(process.env).APP_BASE_URL).origin;
  } catch {
    throw new RouteRequestError(
      503,
      'DEPENDENCY_UNAVAILABLE',
      publicRouteMessage('DEPENDENCY_UNAVAILABLE'),
      true,
    );
  }
  const origin = request.headers.get('origin');
  const fetchSite = request.headers.get('sec-fetch-site');
  if (origin !== appOrigin || fetchSite === 'cross-site' ||
      request.headers.get('x-csrf-token') !== routeCsrfHeaderValue) {
    throw new RouteRequestError(403, 'FORBIDDEN', publicRouteMessage('FORBIDDEN'), false);
  }
}

export async function readRouteJson(request: Request) {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new RouteRequestError(415, 'VALIDATION_FAILED', 'Use Content-Type application/json.', false);
  }
  const advertisedLength = request.headers.get('content-length');
  if (advertisedLength !== null) {
    const length = Number(advertisedLength);
    if (!Number.isInteger(length) || length < 0) {
      throw new RouteRequestError(400, 'VALIDATION_FAILED', 'Cabeçalho Content-Length inválido.', false);
    }
    if (length > maxRouteBodyBytes) {
      throw new RouteRequestError(413, 'VALIDATION_FAILED', 'Corpo da requisição excede 64 KiB.', false);
    }
  }
  if (!request.body) {
    throw new RouteRequestError(400, 'VALIDATION_FAILED', 'Corpo JSON obrigatório.', false);
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxRouteBodyBytes) {
      await reader.cancel();
      throw new RouteRequestError(413, 'VALIDATION_FAILED', 'Corpo da requisição excede 64 KiB.', false);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new RouteRequestError(400, 'VALIDATION_FAILED', 'Corpo JSON inválido.', false);
  }
}

export async function resolveRouteRequest(request: Request, headers: Headers) {
  const store = await cookies();
  const cookieMethods: CookieMethodsServer = {
    getAll: () => store.getAll().map(({ name, value }) => ({ name, value })),
    setAll: (items, cookieHeaders) => {
      for (const { name, value, options } of items) {
        store.set(name, value, options as CookieOptions);
      }
      for (const [name, value] of Object.entries(cookieHeaders)) headers.set(name, value);
    },
  };
  const authorization = request.headers.get('authorization');
  const identity = await resolveIdentityRequest(authorization, cookieMethods);
  return {
    identity,
    client: createCallerScopedClient(authorization, cookieMethods),
  };
}

export function mapRouteRequestError(error: unknown) {
  if (error instanceof RouteRequestError) return error;
  if (error instanceof RouteServiceFailure) {
    const status = error.code === 'AUTH_REQUIRED' ? 401
      : error.code === 'FORBIDDEN' ? 403
        : error.code === 'NOT_FOUND' ? 404
          : error.code === 'VERSION_CONFLICT' ? 409
            : error.code === 'VALIDATION_FAILED' ? 422
              : error.code === 'DEPENDENCY_UNAVAILABLE' ? 503 : 500;
    return new RouteRequestError(status, error.code, publicRouteMessage(error.code), error.recoverable);
  }
  if (error instanceof IdentityRequestError) {
    if (error.status === 401) {
      return new RouteRequestError(401, 'AUTH_REQUIRED', publicRouteMessage('AUTH_REQUIRED'), true);
    }
    if (error.status === 403) {
      return new RouteRequestError(403, 'FORBIDDEN', publicRouteMessage('FORBIDDEN'), false);
    }
    if (error.status === 400) {
      return new RouteRequestError(400, 'VALIDATION_FAILED', 'Credenciais conflitantes.', false);
    }
    return new RouteRequestError(
      503,
      'DEPENDENCY_UNAVAILABLE',
      publicRouteMessage('DEPENDENCY_UNAVAILABLE'),
      true,
    );
  }
  return new RouteRequestError(500, 'INTERNAL_ERROR', publicRouteMessage('INTERNAL_ERROR'), true);
}

export function routeErrorResponse(error: RouteRequestError, requestId: string, headers: Headers) {
  return Response.json(apiErrorResponseSchema.parse({
    error: {
      code: error.code,
      message: error.message,
      recoverable: error.recoverable,
      timestamp: new Date().toISOString(),
      requestId,
    },
  }), { status: error.status, headers });
}

export function currentServiceDate(timeZone: string, clock: () => Date = () => new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(clock());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function logRouteRequest(fields: {
  requestId: string;
  routeTemplate: string;
  method: string;
  status: number;
  startedAt: number;
}) {
  try {
    const config = readServerConfig(process.env);
    logRequest(createLogger(config.LOG_LEVEL), {
      requestId: fields.requestId,
      routeTemplate: fields.routeTemplate,
      method: fields.method,
      status: fields.status,
      durationMs: Math.round((performance.now() - fields.startedAt) * 100) / 100,
    });
  } catch {
    // Logging must never replace the prepared public response.
  }
}
