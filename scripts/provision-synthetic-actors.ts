import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { configureLocalIdentityEnvironment } from './local-identity-environment';
import { root, run, supabaseBinary, type Run } from './process';
import { syntheticClientIds, syntheticParameterSetId } from '@cirne/domain';

export const actorKeys = ['administrator', 'seller_a', 'seller_b', 'manager_a', 'blocked',
  'seller_e2e', 'manager_e2e', 'seller_regression', 'manager_regression', 'logistics_a'] as const;
export type ActorKey = (typeof actorKeys)[number];
export { syntheticClientIds };

type StoredActor = {
  email: string;
  password: string;
  id?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
};

export type ActorManifest = {
  version: 1;
  actors: Record<ActorKey, StoredActor>;
};

type LocalStatus = {
  API_URL: string;
  PUBLISHABLE_KEY: string;
  SECRET_KEY: string;
};

type AuthSession = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user: { id: string };
};

const manifestPath = path.join(root, '.local', 'identity-actors.json');
const verifierPath = path.join(root, '.local', 'supabase-verifier.json');
const roleIds = {
  seller: '00000000-0000-4000-8000-000000000001',
  manager: '00000000-0000-4000-8000-000000000002',
  administrator: '00000000-0000-4000-8000-000000000003',
  logistics: '00000000-0000-4000-8000-000000000004',
} as const;

const syntheticPriceParameters = [
  ...['Heliar', 'América', 'Durex', 'ACDelco', 'Moura', 'Zetta', 'Bosh', 'Tudor', 'Pioneiro']
    .map((label, index) => ({
      id: `32000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      parameter_set_id: syntheticParameterSetId,
      category: 'competitor',
      code: `synthetic_price_brand_${index + 1}`,
      label,
      sort_order: index + 1,
    })),
  ...['SLI', 'EFB', 'AGM'].map((label, index) => ({
    id: `32000000-0000-4000-8100-${String(index + 1).padStart(12, '0')}`,
    parameter_set_id: syntheticParameterSetId,
    category: 'competitor_price_technology',
    code: `synthetic_price_technology_${index + 1}`,
    label,
    sort_order: index + 1,
  })),
  {
    id: '32000000-0000-4000-8200-000000000001', parameter_set_id: syntheticParameterSetId,
    category: 'competitor_price_condition', code: 'synthetic_retail_sale',
    label: 'Venda no varejo — sintético', sort_order: 1,
  },
  {
    id: '32000000-0000-4000-8300-000000000001', parameter_set_id: syntheticParameterSetId,
    category: 'competitor_price_unavailable_reason', code: 'synthetic_not_informed',
    label: 'Preço não informado — sintético', sort_order: 1,
  },
] as const;

const assignments: Record<ActorKey, keyof typeof roleIds> = {
  administrator: 'administrator',
  seller_a: 'seller',
  seller_b: 'seller',
  manager_a: 'manager',
  blocked: 'seller',
  seller_e2e: 'seller',
  manager_e2e: 'manager',
  seller_regression: 'seller',
  manager_regression: 'manager',
  logistics_a: 'logistics',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Configuração local inválida: ${label} ausente.`);
  }
  return value;
}

function parseStatus(output: string): LocalStatus {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error('Não foi possível interpretar o estado local do Supabase.');
  }
  if (!isRecord(value)) throw new Error('Estado local do Supabase incompatível.');
  const apiUrl = expectString(value.API_URL, 'API_URL');
  const publishableKey = expectString(value.PUBLISHABLE_KEY, 'PUBLISHABLE_KEY');
  const secretKey = expectString(value.SECRET_KEY, 'SECRET_KEY');
  const parsedUrl = new URL(apiUrl);
  if (!['127.0.0.1', 'localhost'].includes(parsedUrl.hostname)) {
    throw new Error('O provisionamento sintético só pode apontar para o Supabase local.');
  }
  return { API_URL: parsedUrl.origin, PUBLISHABLE_KEY: publishableKey, SECRET_KEY: secretKey };
}

function createStoredActor(key: ActorKey): StoredActor {
  const suffix = randomBytes(8).toString('hex');
  return {
    email: `${key.replaceAll('_', '-')}.${suffix}@example.invalid`,
    password: randomBytes(24).toString('base64url'),
  };
}

export function createManifest(): ActorManifest {
  return {
    version: 1,
    actors: Object.fromEntries(actorKeys.map((key) => [key, createStoredActor(key)])) as ActorManifest['actors'],
  };
}

function validateStoredActor(value: unknown): value is StoredActor {
  return isRecord(value) && typeof value.email === 'string' && value.email.endsWith('@example.invalid') &&
    typeof value.password === 'string' && value.password.length >= 24;
}

export function parseManifest(raw: string): ActorManifest {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Manifesto sintético inválido; remova o arquivo local e reprovisione.');
  }
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.actors)) {
    throw new Error('Manifesto sintético incompatível; remova o arquivo local e reprovisione.');
  }
  const storedActors = value.actors;
  // Preserve manual-preview credentials while adding isolated automated-browser actors.
  for (const key of ['seller_e2e', 'manager_e2e', 'seller_regression', 'manager_regression', 'logistics_a'] as const) {
    if (!(key in storedActors)) storedActors[key] = createStoredActor(key);
  }
  if (actorKeys.some((key) => !validateStoredActor(storedActors[key]))) {
    throw new Error('Manifesto sintético incompatível; remova o arquivo local e reprovisione.');
  }
  return value as ActorManifest;
}

async function loadManifest(): Promise<ActorManifest> {
  try {
    return parseManifest(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return createManifest();
    throw error;
  }
}

async function requestJson(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
  operation: string,
): Promise<Record<string, unknown>> {
  const response = await fetcher(url, init);
  if (!response.ok) throw new Error(`${operation} falhou (HTTP ${response.status}).`);
  const value: unknown = await response.json();
  if (!isRecord(value)) throw new Error(`${operation} retornou resposta incompatível.`);
  return value;
}

async function signIn(
  fetcher: typeof fetch,
  status: LocalStatus,
  actor: StoredActor,
): Promise<AuthSession | null> {
  const response = await fetcher(`${status.API_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: status.PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: actor.email, password: actor.password }),
  });
  if (!response.ok) return null;
  const value: unknown = await response.json();
  if (!isRecord(value) || !isRecord(value.user) || typeof value.user.id !== 'string' ||
      typeof value.access_token !== 'string' || typeof value.refresh_token !== 'string' ||
      typeof value.expires_in !== 'number') {
    throw new Error('Login sintético retornou resposta incompatível.');
  }
  return value as AuthSession;
}

async function createAuthUser(
  fetcher: typeof fetch,
  status: LocalStatus,
  key: ActorKey,
  actor: StoredActor,
): Promise<void> {
  await requestJson(fetcher, `${status.API_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: status.SECRET_KEY,
      Authorization: `Bearer ${status.SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: actor.email,
      password: actor.password,
      email_confirm: true,
      user_metadata: { actorKey: key, synthetic: true },
    }),
  }, `Criação do ator ${key}`);
}

async function provisionAuthUser(
  fetcher: typeof fetch,
  status: LocalStatus,
  key: ActorKey,
  actor: StoredActor,
): Promise<AuthSession> {
  const existing = await signIn(fetcher, status, actor);
  if (existing) return existing;
  await createAuthUser(fetcher, status, key, actor);
  const created = await signIn(fetcher, status, actor);
  if (!created) throw new Error(`Não foi possível autenticar o ator sintético ${key} após a criação.`);
  return created;
}

function restHeaders(status: LocalStatus, prefer?: string): Record<string, string> {
  return {
    apikey: status.SECRET_KEY,
    Authorization: `Bearer ${status.SECRET_KEY}`,
    'Content-Type': 'application/json',
    'Content-Profile': 'api',
    'Accept-Profile': 'api',
    ...(prefer ? { Prefer: prefer } : {}),
  };
}

async function restWrite(
  fetcher: typeof fetch,
  status: LocalStatus,
  resource: string,
  body: unknown,
  prefer = 'return=minimal',
): Promise<void> {
  const response = await fetcher(`${status.API_URL}/rest/v1/${resource}`, {
    method: 'POST',
    headers: restHeaders(status, prefer),
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Provisionamento de ${resource.split('?')[0]} falhou (HTTP ${response.status}).`);
}

async function activeRelationExists(
  fetcher: typeof fetch,
  status: LocalStatus,
  resource: string,
  filters: Record<string, string>,
): Promise<boolean> {
  const query = new URLSearchParams({ select: 'id', ...filters, revoked_at: 'is.null', limit: '1' });
  const response = await fetcher(`${status.API_URL}/rest/v1/${resource}?${query}`, {
    headers: restHeaders(status),
  });
  if (!response.ok) throw new Error(`Consulta de ${resource} falhou (HTTP ${response.status}).`);
  const value: unknown = await response.json();
  return Array.isArray(value) && value.length > 0;
}

async function readSyntheticParameterSetStatus(
  fetcher: typeof fetch,
  status: LocalStatus,
): Promise<'draft' | 'published' | 'retired' | null> {
  const query = new URLSearchParams({
    select: 'status', id: `eq.${syntheticParameterSetId}`, limit: '1',
  });
  const response = await fetcher(`${status.API_URL}/rest/v1/parameter_sets?${query}`, {
    headers: restHeaders(status),
  });
  if (!response.ok) throw new Error(`Consulta de parameter_sets falhou (HTTP ${response.status}).`);
  const value: unknown = await response.json();
  if (!Array.isArray(value) || value.length === 0) return null;
  const first = value[0];
  if (!isRecord(first) || !['draft', 'published', 'retired'].includes(String(first.status))) {
    throw new Error('Conjunto sintético de parâmetros incompatível.');
  }
  return first.status as 'draft' | 'published' | 'retired';
}

async function readPublishedParameterSetId(
  fetcher: typeof fetch,
  status: LocalStatus,
): Promise<string | null> {
  const query = new URLSearchParams({ select: 'id', status: 'eq.published', limit: '1' });
  const response = await fetcher(`${status.API_URL}/rest/v1/parameter_sets?${query}`, {
    headers: restHeaders(status),
  });
  if (!response.ok) throw new Error(`Consulta de parameter_sets falhou (HTTP ${response.status}).`);
  const value: unknown = await response.json();
  if (!Array.isArray(value) || value.length === 0) return null;
  const first = value[0];
  if (!isRecord(first) || typeof first.id !== 'string') {
    throw new Error('Conjunto publicado de parâmetros incompatível.');
  }
  return first.id;
}

export async function provisionSyntheticActors(options: {
  fetcher?: typeof fetch;
  runner?: Run;
} = {}): Promise<Record<ActorKey, { id: string }>> {
  const fetcher = options.fetcher ?? fetch;
  const runner = options.runner ?? run;
  const statusResult = await runner(supabaseBinary, ['status', '-o', 'json'], 120_000);
  if (!statusResult.ok) throw new Error('Supabase local indisponível. Execute npm run db:start.');
  const status = parseStatus(statusResult.output);
  await configureLocalIdentityEnvironment(status);
  const manifest = await loadManifest();
  const actors = {} as Record<ActorKey, { id: string }>;

  for (const key of actorKeys) {
    const stored = manifest.actors[key];
    const session = await provisionAuthUser(fetcher, status, key, stored);
    stored.id = session.user.id;
    stored.accessToken = session.access_token;
    stored.refreshToken = session.refresh_token;
    stored.expiresAt = Date.now() + session.expires_in * 1000;
    actors[key] = { id: session.user.id };
  }

  const administratorId = actors.administrator.id;
  await restWrite(fetcher, status, 'user_profiles?on_conflict=id', actorKeys.map((key) => ({
    id: actors[key].id,
    display_name: key === 'administrator' ? 'Administrador Sintético' :
      key === 'manager_regression' ? 'Gestor Regressão Sintético' :
      key === 'seller_regression' ? 'Vendedor Regressão Sintético' :
      key === 'manager_e2e' ? 'Gestor E2E Sintético' :
      key === 'logistics_a' ? 'Logística A Sintética' :
      key === 'seller_e2e' ? 'Vendedor E2E Sintético' :
      key === 'manager_a' ? 'Gestor A Sintético' :
      key === 'seller_a' ? 'Vendedor A Sintético' :
      key === 'seller_b' ? 'Vendedor B Sintético' : 'Usuário Bloqueado Sintético',
    status: key === 'blocked' ? 'inactive' : 'active',
    blocked_at: key === 'blocked' ? new Date().toISOString() : null,
  })), 'resolution=merge-duplicates,return=minimal');

  for (const key of actorKeys) {
    const roleId = roleIds[assignments[key]];
    const exists = await activeRelationExists(fetcher, status, 'user_role_assignments', {
      user_id: `eq.${actors[key].id}`,
      role_id: `eq.${roleId}`,
    });
    if (!exists) {
      await restWrite(fetcher, status, 'user_role_assignments', {
        user_id: actors[key].id,
        role_id: roleId,
        assigned_by: administratorId,
      });
    }
  }

  for (const [manager, seller] of [
    ['manager_a', 'seller_a'], ['manager_e2e', 'seller_e2e'], ['manager_regression', 'seller_regression'],
  ] as const) {
    const scopeExists = await activeRelationExists(fetcher, status, 'user_seller_scopes', {
      manager_user_id: `eq.${actors[manager].id}`,
      seller_user_id: `eq.${actors[seller].id}`,
    });
    if (!scopeExists) {
      await restWrite(fetcher, status, 'user_seller_scopes', {
        manager_user_id: actors[manager].id,
        seller_user_id: actors[seller].id,
      });
    }
  }

  await restWrite(fetcher, status, 'commercial_actions?on_conflict=id', {
    id: '39000000-0000-4000-8000-000000000001',
    title: 'Energia para vender mais — sintética',
    description: 'Apresente ao lojista as condições da campanha Heliar vigente e confirme os principais benefícios comerciais.',
    valid_from: '2026-01-01',
    valid_until: '2027-12-31',
    banner_url: 'https://placehold.co/800x800/007f43/ffffff?text=Heliar',
    active: true,
    created_by: actors.manager_a.id,
    updated_by: actors.manager_a.id,
  }, 'resolution=merge-duplicates,return=minimal');

  const parameterSetStatus = await readSyntheticParameterSetStatus(fetcher, status);
  if (parameterSetStatus === null) {
    await restWrite(fetcher, status, 'parameter_sets', {
      id: syntheticParameterSetId,
      version: 1,
      status: 'draft',
      valid_from: '2026-01-01T00:00:00.000Z',
      published_at: null,
      published_by: null,
    });

  }

  if (parameterSetStatus === null || parameterSetStatus === 'draft') {
    await restWrite(fetcher, status, 'parameter_values?on_conflict=id', syntheticPriceParameters,
      'resolution=merge-duplicates,return=minimal');
    const publishedParameterSetId = await readPublishedParameterSetId(fetcher, status);
    if (publishedParameterSetId === null || publishedParameterSetId === syntheticParameterSetId) {
      await restWrite(fetcher, status, 'parameter_sets?on_conflict=id', {
        id: syntheticParameterSetId,
        version: 1,
        status: 'published',
        valid_from: '2026-01-01T00:00:00.000Z',
        published_at: '2026-01-01T00:00:00.000Z',
        published_by: administratorId,
      }, 'resolution=merge-duplicates,return=minimal');
    }
  }

  await restWrite(fetcher, status, 'clients?on_conflict=id', syntheticClientIds.map((id, index) => ({
    id,
    external_reference: `SYN-${String(index + 1).padStart(3, '0')}`,
    name: `Cliente Sintético ${String(index + 1).padStart(2, '0')}`,
    address: `Endereço sintético ${String(index + 1).padStart(2, '0')}`,
    portfolio_reference: 'CARTEIRA-SINTETICA-A',
    status: 'active',
    archived_at: null,
  })), 'resolution=merge-duplicates,return=minimal');

  // Test personas share the explicitly synthetic portfolio, but every link is
  // still materialized so standalone scheduling exercises the production rule.
  for (const seller of ['seller_a', 'seller_e2e', 'seller_regression'] as const) {
    for (const clientId of syntheticClientIds) {
      const scopeExists = await activeRelationExists(fetcher, status, 'client_seller_scopes', {
        client_id: `eq.${clientId}`,
        seller_id: `eq.${actors[seller].id}`,
      });
      if (!scopeExists) {
        await restWrite(fetcher, status, 'client_seller_scopes', {
          client_id: clientId,
          seller_id: actors[seller].id,
          assigned_by: administratorId,
        });
      }
    }
  }

  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  // The privileged key stays outside apps/web/.env.local and is used only by
  // the server-side byte verifier against the isolated local Supabase instance.
  await writeFile(verifierPath, `${JSON.stringify({ apiUrl: status.API_URL, secretKey: status.SECRET_KEY })}\n`,
    { encoding: 'utf8', mode: 0o600 });
  return actors;
}
