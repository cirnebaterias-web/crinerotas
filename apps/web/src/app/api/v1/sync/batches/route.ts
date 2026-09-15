import { randomUUID } from 'node:crypto';
import { cookies } from 'next/headers';
import type { CookieMethodsServer, CookieOptions } from '@supabase/ssr';
import {
  apiErrorResponseSchema,
  maxSyncBatchEvents,
  syncBatchPath,
  syncBatchRequestSchema,
  type SyncErrorCode,
} from '@cirne/contracts';
import { readServerConfig } from '@cirne/config/server';
import {
  createCallerScopedClient,
  IdentityRequestError,
  parseBearer,
  resolveIdentityRequest,
} from '@/server/identity';
import { createLogger, logRequest } from '@/server/logging';
import { processSyncBatch, publicSyncMessage } from '@/server/sync/service';
import { SupabaseSyncEventRepository } from '@/server/sync/supabase-repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const maxBodyBytes = 1024 * 1024;
const csrfHeaderValue = 'cirne-sync-v1';

class SyncRequestError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 413 | 415 | 422 | 500 | 503,
    public readonly code: SyncErrorCode,
    message: string,
    public readonly recoverable: boolean,
  ) {
    super(message);
  }
}

function responseHeaders(requestId: string) {
  return new Headers({
    'Cache-Control': 'private, no-cache, no-store, must-revalidate, max-age=0',
    'X-Request-Id': requestId,
  });
}

async function readLimitedJson(request: Request) {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new SyncRequestError(415, 'VALIDATION_FAILED', 'Use Content-Type application/json.', false);
  }

  const advertisedLength = request.headers.get('content-length');
  if (advertisedLength !== null) {
    const length = Number(advertisedLength);
    if (!Number.isInteger(length) || length < 0) {
      throw new SyncRequestError(400, 'VALIDATION_FAILED', 'Cabeçalho Content-Length inválido.', false);
    }
    if (length > maxBodyBytes) {
      throw new SyncRequestError(413, 'VALIDATION_FAILED', 'Corpo da requisição excede 1 MiB.', false);
    }
  }

  if (!request.body) {
    throw new SyncRequestError(400, 'VALIDATION_FAILED', 'Corpo JSON obrigatório.', false);
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBodyBytes) {
      await reader.cancel();
      throw new SyncRequestError(413, 'VALIDATION_FAILED', 'Corpo da requisição excede 1 MiB.', false);
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
    throw new SyncRequestError(400, 'VALIDATION_FAILED', 'Corpo JSON inválido.', false);
  }
}

function enforceCookieCsrf(request: Request) {
  if (parseBearer(request.headers.get('authorization'))) return;
  let appOrigin: string;
  try {
    appOrigin = new URL(readServerConfig(process.env).APP_BASE_URL).origin;
  } catch {
    throw new SyncRequestError(503, 'DEPENDENCY_UNAVAILABLE', publicSyncMessage('DEPENDENCY_UNAVAILABLE'), true);
  }
  const origin = request.headers.get('origin');
  const fetchSite = request.headers.get('sec-fetch-site');
  if (origin !== appOrigin || fetchSite === 'cross-site' ||
      request.headers.get('x-csrf-token') !== csrfHeaderValue) {
    throw new SyncRequestError(403, 'FORBIDDEN', publicSyncMessage('FORBIDDEN'), false);
  }
}

function mapIdentityError(error: IdentityRequestError) {
  if (error.status === 401) {
    return new SyncRequestError(401, 'AUTH_REQUIRED', publicSyncMessage('AUTH_REQUIRED'), true);
  }
  if (error.status === 403) {
    return new SyncRequestError(403, 'FORBIDDEN', publicSyncMessage('FORBIDDEN'), false);
  }
  if (error.status === 400) {
    return new SyncRequestError(400, 'VALIDATION_FAILED', 'Credenciais conflitantes.', false);
  }
  return new SyncRequestError(503, 'DEPENDENCY_UNAVAILABLE', publicSyncMessage('DEPENDENCY_UNAVAILABLE'), true);
}

function errorResponse(error: SyncRequestError, requestId: string, headers: Headers) {
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

export async function POST(request: Request) {
  const start = performance.now();
  const requestId = randomUUID();
  const headers = responseHeaders(requestId);
  let status = 200;

  try {
    enforceCookieCsrf(request);
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
    if (!identity.roles.includes('seller') || !identity.capabilities.includes('sync.write_self')) {
      throw new SyncRequestError(403, 'FORBIDDEN', publicSyncMessage('FORBIDDEN'), false);
    }

    const body = await readLimitedJson(request);
    const parsed = syncBatchRequestSchema.safeParse(body);
    if (!parsed.success || parsed.data.events.length > maxSyncBatchEvents) {
      throw new SyncRequestError(422, 'VALIDATION_FAILED', publicSyncMessage('VALIDATION_FAILED'), false);
    }
    const client = createCallerScopedClient(authorization, cookieMethods);
    const result = await processSyncBatch(
      parsed.data,
      requestId,
      new SupabaseSyncEventRepository(client),
    );
    return Response.json(result, { status, headers });
  } catch (error) {
    const publicError = error instanceof SyncRequestError
      ? error
      : error instanceof IdentityRequestError
        ? mapIdentityError(error)
        : new SyncRequestError(500, 'INTERNAL_ERROR', publicSyncMessage('INTERNAL_ERROR'), true);
    status = publicError.status;
    return errorResponse(publicError, requestId, headers);
  } finally {
    try {
      const config = readServerConfig(process.env);
      logRequest(createLogger(config.LOG_LEVEL), {
        requestId,
        routeTemplate: syncBatchPath,
        method: 'POST',
        status,
        durationMs: Math.round((performance.now() - start) * 100) / 100,
      });
    } catch {
      // Logging must never replace the prepared public response.
    }
  }
}
