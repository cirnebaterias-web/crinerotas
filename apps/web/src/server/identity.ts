import { createServerClient, type CookieMethodsServer } from '@supabase/ssr';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { meResponseSchema, type MeResponse } from '@cirne/contracts';
import { readIdentityConfig } from '@cirne/config/server';

type ResolvedIdentity = { userId: string | null; identity: unknown };
export type IdentityResolvers = {
  bearer: (token: string) => Promise<ResolvedIdentity>;
  cookie: (cookies: CookieMethodsServer) => Promise<ResolvedIdentity>;
};

export class IdentityRequestError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 503,
    public readonly code: string,
    message: string,
    public readonly recoverable: boolean,
  ) {
    super(message);
  }
}

export function parseBearer(authorization: string | null): string | null {
  if (authorization === null) return null;
  const match = /^Bearer ([^\s,]{1,8192})$/i.exec(authorization);
  if (!match?.[1]) {
    throw new IdentityRequestError(401, 'authentication_required', 'Credencial inválida ou expirada.', true);
  }
  return match[1];
}

export function authCookiePrefix(supabaseUrl: string) {
  return `sb-${new URL(supabaseUrl).hostname.split('.')[0]}-auth-token`;
}

export function createCallerScopedClient(
  authorization: string | null,
  cookieMethods: CookieMethodsServer,
): SupabaseClient {
  let config: ReturnType<typeof readIdentityConfig>;
  try {
    config = readIdentityConfig(process.env);
  } catch {
    throw new IdentityRequestError(503, 'identity_unavailable', 'Identidade temporariamente indisponível.', true);
  }

  const bearer = parseBearer(authorization);
  if (bearer) {
    return createClient(config.SUPABASE_PUBLIC_URL, config.SUPABASE_PUBLISHABLE_KEY, {
      auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${bearer}` } },
    });
  }
  return createServerClient(config.SUPABASE_PUBLIC_URL, config.SUPABASE_PUBLISHABLE_KEY, {
    cookies: cookieMethods,
  });
}

export async function loadCallerIdentity(client: SupabaseClient, token?: string): Promise<ResolvedIdentity> {
  let userResult: Awaited<ReturnType<SupabaseClient['auth']['getUser']>>;
  try {
    userResult = token ? await client.auth.getUser(token) : await client.auth.getUser();
  } catch {
    throw new IdentityRequestError(503, 'identity_unavailable', 'Identidade temporariamente indisponível.', true);
  }
  const { data: userData, error: userError } = userResult;
  if (userError) {
    if (!userError.status || userError.status === 429 || userError.status >= 500) {
      throw new IdentityRequestError(503, 'identity_unavailable', 'Identidade temporariamente indisponível.', true);
    }
    return { userId: null, identity: null };
  }
  if (!userData.user) return { userId: null, identity: null };

  const { data, error } = await client.schema('api').rpc('get_my_identity');
  if (error) {
    throw new IdentityRequestError(503, 'identity_unavailable', 'Identidade temporariamente indisponível.', true);
  }
  return { userId: userData.user.id, identity: data };
}

function defaultResolvers(): IdentityResolvers {
  let config: ReturnType<typeof readIdentityConfig>;
  try {
    config = readIdentityConfig(process.env);
  } catch {
    throw new IdentityRequestError(503, 'identity_unavailable', 'Identidade temporariamente indisponível.', true);
  }

  return {
    bearer: async (token) => {
      const client = createClient(config.SUPABASE_PUBLIC_URL, config.SUPABASE_PUBLISHABLE_KEY, {
        auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
        global: { headers: { Authorization: `Bearer ${token}` } },
      });
      return loadCallerIdentity(client, token);
    },
    cookie: async (cookieMethods) => {
      const client = createServerClient(config.SUPABASE_PUBLIC_URL, config.SUPABASE_PUBLISHABLE_KEY, {
        cookies: cookieMethods,
      });
      return loadCallerIdentity(client);
    },
  };
}

export async function resolveIdentityRequest(
  authorization: string | null,
  cookies: CookieMethodsServer,
  resolvers?: IdentityResolvers,
  configuredSupabaseUrl = process.env.SUPABASE_PUBLIC_URL,
): Promise<MeResponse> {
  const bearer = parseBearer(authorization);
  const allCookies = await cookies.getAll() ?? [];
  const cookiePrefix = configuredSupabaseUrl ? authCookiePrefix(configuredSupabaseUrl) : 'sb-';
  const hasSessionCookie = allCookies.some(({ name }) =>
    name === cookiePrefix || name.startsWith(`${cookiePrefix}.`));

  if (bearer && hasSessionCookie) {
    throw new IdentityRequestError(400, 'conflicting_credentials', 'Envie somente uma forma de autenticação.', false);
  }
  if (!bearer && !hasSessionCookie) {
    throw new IdentityRequestError(401, 'authentication_required', 'Autenticação necessária.', true);
  }

  const activeResolvers = resolvers ?? defaultResolvers();
  const resolved = bearer
    ? await activeResolvers.bearer(bearer)
    : await activeResolvers.cookie(cookies);

  if (!resolved.userId) {
    throw new IdentityRequestError(401, 'authentication_required', 'Credencial inválida ou expirada.', true);
  }
  if (resolved.identity === null) {
    throw new IdentityRequestError(403, 'access_denied', 'Acesso não autorizado.', false);
  }

  const parsed = meResponseSchema.safeParse(resolved.identity);
  if (!parsed.success) {
    throw new IdentityRequestError(503, 'identity_unavailable', 'Identidade temporariamente indisponível.', true);
  }
  if (parsed.data.id !== resolved.userId || parsed.data.status !== 'active') {
    throw new IdentityRequestError(403, 'access_denied', 'Acesso não autorizado.', false);
  }
  return parsed.data;
}
