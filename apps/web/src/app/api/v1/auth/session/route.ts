import { randomUUID } from 'node:crypto';
import { cookies } from 'next/headers';
import type { CookieOptions } from '@supabase/ssr';
import { authSessionPath, loginRequestSchema } from '@cirne/contracts';
import { readIdentityConfig } from '@cirne/config/server';
import { authCookiePrefix, createCallerScopedClient, sessionCookieOptions } from '@/server/identity';
import { signInSeller } from '@/server/auth/session';
import {
  enforceRouteCookieCsrf, logRouteRequest, mapRouteRequestError, readRouteJson,
  routeErrorResponse, routeResponseHeaders, RouteRequestError,
} from '@/server/routes/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handle(request: Request) {
  const startedAt = performance.now();
  const requestId = randomUUID();
  const headers = routeResponseHeaders(requestId);
  let status = 200;
  let clearRejectedLogin: (() => void) | undefined;
  try {
    if (request.headers.has('authorization')) {
      throw new RouteRequestError(400, 'VALIDATION_FAILED', 'Use somente a sessão do navegador.', false);
    }
    enforceRouteCookieCsrf(request);
    const store = await cookies();
    const clearIncomingSession = () => {
      const prefix = authCookiePrefix(readIdentityConfig(process.env).SUPABASE_PUBLIC_URL);
      for (const { name } of store.getAll()) {
        if (name === prefix || name.startsWith(`${prefix}.`)) {
          store.set(name, '', { ...sessionCookieOptions(), maxAge: 0 });
        }
      }
    };
    const pending = new Map<string, { value: string; options: CookieOptions }>();
    const client = createCallerScopedClient(null, {
      getAll: () => {
        const current = new Map(store.getAll().map(({ name, value }) => [name, value]));
        for (const [name, { value }] of pending) current.set(name, value);
        return [...current].map(([name, value]) => ({ name, value }));
      },
      setAll: (items) => {
        for (const { name, value, options } of items) pending.set(name, { value, options });
      },
    });
    if (request.method === 'DELETE') {
      try {
        const { error } = await client.auth.signOut({ scope: 'local' });
        if (error) throw new RouteRequestError(503, 'DEPENDENCY_UNAVAILABLE', 'Sessão removida deste navegador. Não foi possível confirmar o encerramento no servidor.', true);
      } finally {
        clearIncomingSession();
      }
      status = 204;
      return new Response(null, { status, headers });
    }
    const parsed = loginRequestSchema.safeParse(await readRouteJson(request));
    if (!parsed.success) throw new RouteRequestError(400, 'VALIDATION_FAILED', 'Informe um e-mail válido e sua senha.', false);
    clearRejectedLogin = clearIncomingSession;
    const identity = await signInSeller(client, parsed.data);
    for (const [name, { value, options }] of pending) store.set(name, value, { ...options, ...sessionCookieOptions() });
    return Response.json(identity, { status, headers });
  } catch (error) {
    clearRejectedLogin?.();
    const publicError = mapRouteRequestError(error);
    status = publicError.status;
    return routeErrorResponse(publicError, requestId, headers);
  } finally {
    logRouteRequest({ requestId, routeTemplate: authSessionPath, method: request.method, status, startedAt });
  }
}

export const POST = handle;
export const DELETE = handle;
