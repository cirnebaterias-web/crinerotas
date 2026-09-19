import { cookies } from 'next/headers';
import type { CookieMethodsServer, CookieOptions } from '@supabase/ssr';
import {
  apiErrorResponseSchema,
  visitCsrfToken,
  type VisitErrorCode,
} from '@cirne/contracts';
import { readServerConfig } from '@cirne/config/server';
import {
  createCallerScopedClient,
  IdentityRequestError,
  parseBearer,
  resolveIdentityRequest,
} from '../identity';
import { publicVisitMessage, VisitServiceFailure } from './service';

const maxBodyBytes = 64 * 1024;

export class VisitRequestError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 409 | 413 | 415 | 422 | 500 | 503,
    public readonly code: VisitErrorCode,
    message: string,
    public readonly recoverable: boolean,
  ) {
    super(message);
  }
}

export function visitResponseHeaders(requestId: string) {
  return new Headers({
    'Cache-Control': 'private, no-cache, no-store, must-revalidate, max-age=0',
    'X-Request-Id': requestId,
  });
}

export function enforceVisitCookieCsrf(request: Request) {
  if (parseBearer(request.headers.get('authorization'))) return;
  let appOrigin: string;
  try {
    appOrigin = new URL(readServerConfig(process.env).APP_BASE_URL).origin;
  } catch {
    throw new VisitRequestError(503, 'DEPENDENCY_UNAVAILABLE', publicVisitMessage('DEPENDENCY_UNAVAILABLE'), true);
  }
  if (request.headers.get('origin') !== appOrigin ||
      request.headers.get('sec-fetch-site') === 'cross-site' ||
      request.headers.get('x-csrf-token') !== visitCsrfToken) {
    throw new VisitRequestError(403, 'FORBIDDEN', publicVisitMessage('FORBIDDEN'), false);
  }
}

export async function readVisitJson(request: Request) {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new VisitRequestError(415, 'VALIDATION_FAILED', 'Use Content-Type application/json.', false);
  }
  const advertisedLength = request.headers.get('content-length');
  if (advertisedLength !== null && (!/^\d+$/.test(advertisedLength) || Number(advertisedLength) > maxBodyBytes)) {
    throw new VisitRequestError(413, 'VALIDATION_FAILED', 'Corpo da requisição excede 64 KiB.', false);
  }
  if (!request.body) throw new VisitRequestError(400, 'VALIDATION_FAILED', 'Corpo JSON obrigatório.', false);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBodyBytes) {
      await reader.cancel();
      throw new VisitRequestError(413, 'VALIDATION_FAILED', 'Corpo da requisição excede 64 KiB.', false);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new VisitRequestError(400, 'VALIDATION_FAILED', 'Corpo JSON inválido.', false);
  }
}

export async function resolveVisitRequest(request: Request, headers: Headers) {
  const store = await cookies();
  const cookieMethods: CookieMethodsServer = {
    getAll: () => store.getAll().map(({ name, value }) => ({ name, value })),
    setAll: (items, cookieHeaders) => {
      for (const { name, value, options } of items) store.set(name, value, options as CookieOptions);
      for (const [name, value] of Object.entries(cookieHeaders)) headers.set(name, value);
    },
  };
  const authorization = request.headers.get('authorization');
  return {
    identity: await resolveIdentityRequest(authorization, cookieMethods),
    client: createCallerScopedClient(authorization, cookieMethods),
  };
}

export function mapVisitRequestError(error: unknown) {
  if (error instanceof VisitRequestError) return error;
  if (error instanceof VisitServiceFailure) {
    const status = error.code === 'AUTH_REQUIRED' ? 401
      : error.code === 'FORBIDDEN' || error.code === 'NOT_FOUND' ? 403
        : error.code === 'VERSION_CONFLICT' || error.code === 'EVENT_OUT_OF_ORDER' || error.code === 'IDEMPOTENCY_KEY_REUSED' ? 409
          : error.code === 'VALIDATION_FAILED' ? 422
            : error.code === 'DEPENDENCY_UNAVAILABLE' ? 503 : 500;
    return new VisitRequestError(status, error.code, publicVisitMessage(error.code), error.recoverable);
  }
  if (error instanceof IdentityRequestError) {
    if (error.status === 401) return new VisitRequestError(401, 'AUTH_REQUIRED', publicVisitMessage('AUTH_REQUIRED'), true);
    if (error.status === 400) return new VisitRequestError(400, 'VALIDATION_FAILED', 'Credenciais conflitantes.', false);
    if (error.status === 403) return new VisitRequestError(403, 'FORBIDDEN', publicVisitMessage('FORBIDDEN'), false);
    return new VisitRequestError(503, 'DEPENDENCY_UNAVAILABLE', publicVisitMessage('DEPENDENCY_UNAVAILABLE'), true);
  }
  return new VisitRequestError(500, 'INTERNAL_ERROR', publicVisitMessage('INTERNAL_ERROR'), true);
}

export function visitErrorResponse(error: VisitRequestError, requestId: string, headers: Headers) {
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
