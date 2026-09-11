import { randomUUID } from 'node:crypto';
import { cookies } from 'next/headers';
import type { CookieMethodsServer, CookieOptions } from '@supabase/ssr';
import { apiErrorResponseSchema, mePath } from '@cirne/contracts';
import { readServerConfig } from '@cirne/config/server';
import { createLogger, logRequest } from '@/server/logging';
import { IdentityRequestError, resolveIdentityRequest } from '@/server/identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function errorResponse(error: IdentityRequestError, requestId: string, extraHeaders: Headers) {
  return Response.json(apiErrorResponseSchema.parse({
    error: {
      code: error.code,
      message: error.message,
      recoverable: error.recoverable,
      timestamp: new Date().toISOString(),
      requestId,
    },
  }), { status: error.status, headers: extraHeaders });
}

export async function GET(request: Request) {
  const start = performance.now();
  const requestId = randomUUID();
  const responseHeaders = new Headers({
    'Cache-Control': 'private, no-cache, no-store, must-revalidate, max-age=0',
    'X-Request-Id': requestId,
  });
  let status = 200;

  try {
    const store = await cookies();
    const cookieMethods: CookieMethodsServer = {
      getAll: () => store.getAll().map(({ name, value }) => ({ name, value })),
      setAll: (items, headers) => {
        for (const { name, value, options } of items) {
          store.set(name, value, options as CookieOptions);
        }
        for (const [name, value] of Object.entries(headers)) responseHeaders.set(name, value);
      },
    };
    const identity = await resolveIdentityRequest(request.headers.get('authorization'), cookieMethods);
    return Response.json(identity, { status, headers: responseHeaders });
  } catch (error) {
    const publicError = error instanceof IdentityRequestError
      ? error
      : new IdentityRequestError(503, 'identity_unavailable', 'Identidade temporariamente indisponível.', true);
    status = publicError.status;
    return errorResponse(publicError, requestId, responseHeaders);
  } finally {
    try {
      const config = readServerConfig(process.env);
      logRequest(createLogger(config.LOG_LEVEL), {
        requestId,
        routeTemplate: mePath,
        method: 'GET',
        status,
        durationMs: Math.round((performance.now() - start) * 100) / 100,
      });
    } catch {
      // Logging must never replace the prepared public response.
    }
  }
}
