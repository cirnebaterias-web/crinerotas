import { z } from 'zod';

const httpOrigin = z.string().url().refine((value) => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password &&
      url.pathname === '/' && !url.search && !url.hash;
  } catch { return false; }
});
const schema = z.object({
  APP_BASE_URL: httpOrigin,
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

const identitySchema = z.object({
  SUPABASE_PUBLIC_URL: httpOrigin,
  SUPABASE_PUBLISHABLE_KEY: z.string().trim().min(20).max(512),
});

export function readServerConfig(env: Record<string, string | undefined>) {
  const result = schema.safeParse(env);
  if (!result.success) {
    // Never interpolate values or Zod error payloads (may contain inputs).
    const keys = [...new Set(result.error.issues.map((issue) => issue.path[0]))].join(', ');
    throw new Error(`Configuração inválida: ${keys}. Confira o exemplo de ambiente.`);
  }
  return result.data;
}

export function readIdentityConfig(env: Record<string, string | undefined>) {
  const result = identitySchema.safeParse(env);
  if (!result.success) {
    const keys = [...new Set(result.error.issues.map((issue) => issue.path[0]))].join(', ');
    throw new Error(`Configuração de identidade inválida: ${keys}. Confira o exemplo de ambiente.`);
  }
  return result.data;
}
