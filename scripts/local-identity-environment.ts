import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { root } from './process';

export type PublicIdentityEnvironment = {
  API_URL: string;
  PUBLISHABLE_KEY: string;
};

const localEnvironmentPath = path.join(root, 'apps', 'web', '.env.local');

export function mergeLocalIdentityEnvironment(
  existing: string,
  values: PublicIdentityEnvironment,
): string {
  const url = new URL(values.API_URL);
  if (!['http:', 'https:'].includes(url.protocol) ||
      !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error('A configuracao de identidade aceita somente a origem HTTP(S) do Supabase local.');
  }
  const publishableKey = values.PUBLISHABLE_KEY.trim();
  if (!publishableKey || publishableKey.startsWith('sb_secret_')) {
    throw new Error('A chave publica local do Supabase e invalida.');
  }
  if (/^\s*SUPABASE_(?:SECRET|SERVICE_ROLE)_KEY\s*=/mi.test(existing)) {
    throw new Error('Remova a chave privilegiada de apps/web/.env.local antes de continuar.');
  }

  const keptLines = existing.replaceAll('\r\n', '\n').split('\n').filter((line) =>
    !/^\s*SUPABASE_(?:PUBLIC_URL|PUBLISHABLE_KEY)\s*=/.test(line));
  while (keptLines.at(-1) === '') keptLines.pop();
  return `${keptLines.join('\n')}\nSUPABASE_PUBLIC_URL=${url.origin}\n` +
    `SUPABASE_PUBLISHABLE_KEY=${publishableKey}\n`;
}

export async function configureLocalIdentityEnvironment(values: PublicIdentityEnvironment) {
  let existing = 'APP_BASE_URL=http://127.0.0.1:3000\nLOG_LEVEL=info\n';
  try {
    existing = await readFile(localEnvironmentPath, 'utf8');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const merged = mergeLocalIdentityEnvironment(existing, values);
  await writeFile(localEnvironmentPath, merged, { encoding: 'utf8', mode: 0o600 });
}
