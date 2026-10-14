import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { readIdentityConfig } from '@cirne/config/server';

const localVerifierFile = 'supabase-verifier.json';

function validKey(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length >= 20;
}

async function localVerifierKey(origin: string): Promise<string | null> {
  if (process.env.NODE_ENV === 'production' ||
      !['127.0.0.1', 'localhost'].includes(new URL(origin).hostname)) return null;
  const candidates = [
    path.resolve(process.cwd(), '.local', localVerifierFile),
    path.resolve(process.cwd(), '..', '..', '.local', localVerifierFile),
  ];
  for (const candidate of candidates) {
    try {
      const value: unknown = JSON.parse(await readFile(candidate, 'utf8'));
      if (value && typeof value === 'object' && 'apiUrl' in value && 'secretKey' in value &&
          value.apiUrl === origin && validKey(value.secretKey)) return value.secretKey;
    } catch { /* Missing or invalid local fixture: try the next fixed workspace location. */ }
  }
  return null;
}

export async function createEvidenceVerifierClient() {
  const config = readIdentityConfig(process.env);
  const key = process.env.CIRNE_SUPABASE_VERIFIER_KEY?.trim() ||
    await localVerifierKey(config.SUPABASE_PUBLIC_URL);
  if (!validKey(key) || key === config.SUPABASE_PUBLISHABLE_KEY) {
    throw new Error('Verificador de evidências indisponível.');
  }
  return createClient(config.SUPABASE_PUBLIC_URL, key, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
}
