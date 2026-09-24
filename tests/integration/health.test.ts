import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { promisify } from 'node:util';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { root, run, supabaseBinary } from '../../scripts/process';

const exec = promisify(execFile);
const useRancherDesktopWsl = process.platform === 'win32' &&
  process.env.CIRNE_DOCKER_BACKEND === 'rancher-desktop-wsl';
const dockerProgram = useRancherDesktopWsl ? 'wsl' : 'docker';
const dockerPrefix = useRancherDesktopWsl
  ? ['-d', 'rancher-desktop', '--', 'docker']
  : [];
let server: ChildProcess | undefined;
let origin: string;
let output = '';
let identityEnvironment: { SUPABASE_PUBLIC_URL: string; SUPABASE_PUBLISHABLE_KEY: string };
let actorManifest: {
  actors: Record<string, { id: string; accessToken: string; email: string; password: string }>;
};
let publishedRouteId = '';

async function listenOnRandomPort(socket: Server) {
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      socket.off('error', reject);
      resolve();
    });
  });

  const address = socket.address();
  if (!address || typeof address === 'string') throw new Error('No TCP address');

  return address.port;
}

async function closeServer(socket: Server) {
  await new Promise<void>((resolve) => socket.close(() => resolve()));
}

async function freePort() {
  const socket = createServer();
  const port = await listenOnRandomPort(socket);
  await closeServer(socket);
  return port;
}

async function stopProcess(process: ChildProcess) {
  if (process.exitCode !== null) return;
  const stopped = new Promise<void>((resolve) => process.once('exit', () => resolve()));
  process.kill();
  await stopped;
}

async function runWithClosedInput(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(`Process exited with code ${code ?? 'unknown'}.`), { stdout, stderr, code }));
    });
    child.stdin?.end();
  });
}

beforeAll(async () => {
  const statusResult = await run(supabaseBinary, ['status', '-o', 'json'], 120_000);
  if (!statusResult.ok) throw new Error('Supabase local is unavailable for integration tests');
  const localStatus = JSON.parse(statusResult.output) as Record<string, unknown>;
  if (typeof localStatus.API_URL !== 'string' || typeof localStatus.PUBLISHABLE_KEY !== 'string') {
    throw new Error('Supabase local status is incompatible');
  }
  identityEnvironment = {
    SUPABASE_PUBLIC_URL: localStatus.API_URL,
    SUPABASE_PUBLISHABLE_KEY: localStatus.PUBLISHABLE_KEY,
  };
  actorManifest = JSON.parse(await readFile(path.join(root, '.local', 'identity-actors.json'), 'utf8'));

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const port = await freePort();
    const candidateOrigin = `http://127.0.0.1:${port}`;
    const candidate = spawn(process.execPath, [path.join(root, 'scripts/start-web.mjs')], {
      cwd: path.join(root, 'apps/web'), windowsHide: true,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        PORT: String(port),
        NODE_ENV: 'production',
        APP_BASE_URL: candidateOrigin,
        OPERATIONAL_TIME_ZONE: 'America/Sao_Paulo',
        LOG_LEVEL: 'info',
        NEXT_TELEMETRY_DISABLED: '1',
        ...identityEnvironment,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let attemptOutput = '';
    candidate.stdout?.on('data', (chunk) => { attemptOutput += String(chunk); output += String(chunk); });
    candidate.stderr?.on('data', (chunk) => { attemptOutput += String(chunk); output += String(chunk); });

    const deadline = Date.now() + 50000;
    let bindCollision = false;
    while (Date.now() < deadline) {
      if (candidate.exitCode !== null) {
        if (/EADDRINUSE/.test(attemptOutput) && attempt < 5) {
          bindCollision = true;
          break;
        }
        throw new Error(`Server exited before readiness: ${attemptOutput}`);
      }
      try {
        if ((await fetch(`${candidateOrigin}/api/v1/health/live`, { signal: AbortSignal.timeout(500) })).ok) {
          server = candidate;
          origin = candidateOrigin;
          return;
        }
      } catch { /* readiness polling */ }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    await stopProcess(candidate);
    if (!bindCollision) throw new Error(`Server did not start: ${attemptOutput}`);
  }

  throw new Error(`Server did not start: ${output}`);
});

afterAll(async () => {
  if (server) await stopProcess(server);
});

it('signs in through HttpOnly cookies, reads the seller route and signs out without exposing tokens', async () => {
  const seller = actorManifest.actors.seller_a!;
  const headers = { origin, 'content-type': 'application/json', 'x-csrf-token': 'cirne-route-v1' };
  const response = await fetch(`${origin}/api/v1/auth/session`, {
    method: 'POST', headers, body: JSON.stringify({ email: seller.email, password: seller.password }),
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toContain('no-store');
  const result = await response.text();
  expect(JSON.parse(result)).toMatchObject({ id: seller.id, roles: ['seller'] });
  expect(result).not.toMatch(/access_token|refresh_token|password|email/i);
  const setCookies = response.headers.getSetCookie();
  expect(setCookies.length).toBeGreaterThan(0);
  for (const cookie of setCookies) {
    expect(cookie).toMatch(/httponly/i);
    expect(cookie).toMatch(/samesite=lax/i);
  }
  const cookie = setCookies.map((item) => item.split(';')[0]).join('; ');
  const me = await fetch(`${origin}/api/v1/me`, { headers: { cookie } });
  expect(me.status).toBe(200);
  expect(await me.json()).toMatchObject({ id: seller.id });
  const route = await fetch(`${origin}/api/v1/me/routes/today`, { headers: { cookie } });
  expect(route.status).toBe(200);
  expect(await route.json()).toMatchObject({ schemaVersion: 3 });
  const logout = await fetch(`${origin}/api/v1/auth/session`, { method: 'DELETE', headers: { ...headers, cookie } });
  expect(logout.status).toBe(204);
  expect(logout.headers.getSetCookie().every((value) => /max-age=0/i.test(value))).toBe(true);
  expect((await fetch(`${origin}/api/v1/me`)).status).toBe(401);
  expect(output.includes(seller.password)).toBe(false);
  expect(output.includes(seller.accessToken)).toBe(false);
});

it('clears a previous browser session when an account switch is rejected', async () => {
  const seller = actorManifest.actors.seller_a!;
  const blocked = actorManifest.actors.blocked!;
  const headers = { origin, 'content-type': 'application/json', 'x-csrf-token': 'cirne-route-v1' };
  const signedIn = await fetch(`${origin}/api/v1/auth/session`, {
    method: 'POST', headers, body: JSON.stringify({ email: seller.email, password: seller.password }),
  });
  expect(signedIn.status).toBe(200);
  const cookie = signedIn.headers.getSetCookie().map((item) => item.split(';')[0]).join('; ');
  const rejected = await fetch(`${origin}/api/v1/auth/session`, {
    method: 'POST', headers: { ...headers, cookie }, body: JSON.stringify({ email: blocked.email, password: blocked.password }),
  });
  expect(rejected.status).toBe(403);
  expect(rejected.headers.getSetCookie().length).toBeGreaterThan(0);
  expect(rejected.headers.getSetCookie().every((value) => /max-age=0/i.test(value))).toBe(true);
});

it('rejects login failures, blocked/non-seller identities, CSRF, bearer and malformed bodies', async () => {
  const seller = actorManifest.actors.seller_a!;
  const headers = { origin, 'content-type': 'application/json', 'x-csrf-token': 'cirne-route-v1' };
  for (const [key, expected] of [['blocked', 403], ['manager_a', 403], ['invalid', 401]] as const) {
    const actor = actorManifest.actors[key] ?? { email: seller.email, password: 'incorrect-synthetic-password' };
    const response = await fetch(`${origin}/api/v1/auth/session`, {
      method: 'POST', headers, body: JSON.stringify({ email: actor.email, password: actor.password }),
    });
    expect(response.status).toBe(expected);
    expect(response.headers.getSetCookie()).toHaveLength(0);
    const body = await response.text();
    expect(body).not.toContain(actor.password);
    expect(body).not.toContain(actor.email);
  }
  for (const method of ['POST', 'DELETE']) {
    for (const badHeaders of [
      { ...headers, origin: 'https://other.example' },
      { ...headers, 'x-csrf-token': '' },
      { ...headers, authorization: 'Bearer synthetic' },
    ]) {
      const response = await fetch(`${origin}/api/v1/auth/session`, { method, headers: badHeaders });
      expect([400, 403]).toContain(response.status);
    }
  }
  expect((await fetch(`${origin}/api/v1/auth/session`, { method: 'POST', headers, body: '{}' })).status).toBe(400);
  expect((await fetch(`${origin}/api/v1/auth/session`, {
    method: 'POST', headers, body: JSON.stringify({ password: 'a'.repeat(65536) }),
  })).status).toBe(413);
});

it('serves a minimal no-store canary without database credentials', async () => {
  const response = await fetch(`${origin}/api/v1/health/live?token=not-for-logs`, { headers: { authorization: 'Bearer synthetic-private' } });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: 'ok' });
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('x-request-id')).toMatch(/^[\da-f-]{36}$/);
  expect(output).not.toMatch(/not-for-logs|synthetic-private/);
});

it('runs the CLI as a real process against the production server', async () => {
  const result = await exec(process.execPath, ['--import', 'tsx', 'apps/cli/src/index.ts', '--url', origin, '--json'], { cwd: root, windowsHide: true });
  expect(JSON.parse(result.stdout)).toEqual({ status: 'ok' });
});

it('returns nonzero from the CLI for an unreachable server', async () => {
  const failingEndpoint = createServer((socket) => socket.destroy());
  const port = await listenOnRandomPort(failingEndpoint);
  try {
    await expect(exec(process.execPath, ['--import', 'tsx', 'apps/cli/src/index.ts', '--url', `http://127.0.0.1:${port}`, '--json'], { cwd: root, windowsHide: true })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('inacessível') });
  } finally {
    await closeServer(failingEndpoint);
  }
});

it('returns the caller-scoped seller and manager contexts', async () => {
  const seller = actorManifest.actors.seller_a;
  const sellerB = actorManifest.actors.seller_b;
  const manager = actorManifest.actors.manager_a;
  if (!seller || !sellerB || !manager) throw new Error('Synthetic actors missing');

  const sellerResponse = await fetch(`${origin}/api/v1/me`, {
    headers: { Authorization: `Bearer ${seller.accessToken}` },
  });
  expect(sellerResponse.status).toBe(200);
  expect(await sellerResponse.json()).toMatchObject({
    id: seller.id,
    roles: ['seller'],
    capabilities: ['identity.read_self', 'route.read_self', 'route.reorder_self', 'sync.write_self', 'visit.start_self'],
    scopeIds: [seller.id],
    status: 'active',
  });
  expect(sellerResponse.headers.get('cache-control')).toContain('no-store');

  const managerResponse = await fetch(`${origin}/api/v1/me`, {
    headers: { Authorization: `Bearer ${manager.accessToken}` },
  });
  expect(managerResponse.status).toBe(200);
  const managerBody = await managerResponse.json() as { scopeIds: string[] };
  expect(managerBody.scopeIds).toEqual([seller.id]);
  expect(managerBody.scopeIds).not.toContain(sellerB.id);
});

it('fails closed for missing, invalid, blocked and conflicting credentials', async () => {
  const blocked = actorManifest.actors.blocked;
  if (!blocked) throw new Error('Blocked synthetic actor missing');
  expect((await fetch(`${origin}/api/v1/me`)).status).toBe(401);
  expect((await fetch(`${origin}/api/v1/me`, {
    headers: { Authorization: 'Bearer invalid-synthetic-token' },
  })).status).toBe(401);

  const blockedResponse = await fetch(`${origin}/api/v1/me`, {
    headers: { Authorization: `Bearer ${blocked.accessToken}` },
  });
  expect(blockedResponse.status).toBe(403);
  expect(JSON.stringify(await blockedResponse.json())).not.toMatch(/email|role|token|blocked/i);

  const conflicting = await fetch(`${origin}/api/v1/me`, {
    headers: {
      Authorization: `Bearer ${blocked.accessToken}`,
      Cookie: 'sb-127-auth-token=synthetic-cookie',
    },
  });
  expect(conflicting.status).toBe(400);
});

it('runs the identity CLI without placing the token in process arguments or output', async () => {
  const seller = actorManifest.actors.seller_a;
  if (!seller) throw new Error('Seller synthetic actor missing');
  const result = await runWithClosedInput(process.execPath, [
    '--import', 'tsx', 'apps/cli/src/identity-cli.ts', '--url', origin, '--json',
  ], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      CIRNE_ACCESS_TOKEN: seller.accessToken,
    },
  });
  expect(JSON.parse(result.stdout)).toMatchObject({ id: seller.id, roles: ['seller'] });
  expect(result.stdout + result.stderr).not.toContain(seller.accessToken);
});

it('runs the synthetic sync round-trip CLI without exposing the token or payload', async () => {
  const seller = actorManifest.actors.seller_a;
  if (!seller) throw new Error('Seller synthetic actor missing');
  const result = await runWithClosedInput(process.execPath, [
    '--import', 'tsx', 'apps/cli/src/sync-cli.ts', '--url', origin, '--json',
  ], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      CIRNE_ACCESS_TOKEN: seller.accessToken,
    },
  });
  expect(JSON.parse(result.stdout)).toEqual({
    status: 'ok',
    checks: { firstConfirmation: true, replayMatched: true, divergentRejected: true },
  });
  expect(result.stdout + result.stderr).not.toContain(seller.accessToken);
  expect(result.stdout + result.stderr).not.toMatch(/draftOfflineId|routeVersionStopId|acknowledged/);
});

it('runs the synthetic route round-trip CLI without exposing tokens or client snapshots', async () => {
  const seller = actorManifest.actors.seller_a;
  const manager = actorManifest.actors.manager_a;
  if (!seller || !manager) throw new Error('Synthetic route actors missing');
  const cliArguments = [
    '--import', 'tsx', 'apps/cli/src/routes-cli.ts', '--url', origin, '--json',
  ];
  const cliOptions = {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      CIRNE_MANAGER_ACCESS_TOKEN: manager.accessToken,
      CIRNE_SELLER_ACCESS_TOKEN: seller.accessToken,
    },
  };
  const beforeResponse = await fetch(`${origin}/api/v1/me/routes/today`, {
    headers: { Authorization: `Bearer ${seller.accessToken}` },
  });
  expect(beforeResponse.status).toBe(200);
  const before = await beforeResponse.json() as {
    availability: string;
    route?: {
      executionVersion: number;
      versionNumber: number;
      compositionChange?: { reason: string } | null;
      stops: Array<{ client: { id: string } }>;
    };
  };
  const expectedClientIds = [
    '10000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000003',
  ];
  const alreadyCurrent = before.route?.compositionChange?.reason ===
    'Ajuste sintetico de composicao para validacao local' &&
    JSON.stringify(before.route.stops.map(({ client }) => client.id).sort()) ===
      JSON.stringify(expectedClientIds);
  const expectedRouteVersion = before.route
    ? before.route.versionNumber + (alreadyCurrent ? 0 : 1)
    : 2;
  const expectedCreated = !before.route;
  const expectedPublished = !before.route || !alreadyCurrent;
  const result = await runWithClosedInput(process.execPath, cliArguments, cliOptions);
  const body = JSON.parse(result.stdout) as {
    routeId: string;
    stopCount: number;
    executionVersion: number;
    checks: { composition: string; reasonConfirmed: boolean; reordered: string };
  };
  publishedRouteId = body.routeId;
  expect(body).toMatchObject({
    status: 'ok',
    routeVersion: expectedRouteVersion,
    executionVersion: expect.any(Number),
    routeStatus: 'published',
    stopCount: 2,
    checks: { created: expectedCreated, published: expectedPublished, loadedBySeller: true,
      composition: alreadyCurrent ? 'already_current' : 'applied',
      reasonConfirmed: true,
      reordered: expect.stringMatching(/^(applied|already_canonical)$/) },
  });
  expect(result.stdout + result.stderr).not.toContain(manager.accessToken);
  expect(result.stdout + result.stderr).not.toContain(seller.accessToken);
  expect(result.stdout + result.stderr).not.toMatch(/Cliente Sintético|Endereço sintético|snapshot/i);

  const repeated = await runWithClosedInput(process.execPath, cliArguments, cliOptions);
  expect(JSON.parse(repeated.stdout)).toEqual({
    ...body,
    checks: {
      ...body.checks,
      created: false,
      published: false,
      composition: 'already_current',
      reordered: 'already_canonical',
    },
  });
  expect(repeated.stdout + repeated.stderr).not.toContain(manager.accessToken);
  expect(repeated.stdout + repeated.stderr).not.toContain(seller.accessToken);
});

it('enforces route scope at the BFF while preserving the published aggregate', async () => {
  const seller = actorManifest.actors.seller_a;
  const sellerB = actorManifest.actors.seller_b;
  const manager = actorManifest.actors.manager_a;
  if (!seller || !sellerB || !manager || !publishedRouteId) throw new Error('Published synthetic route missing');

  const ownRoute = await fetch(`${origin}/api/v1/me/routes/today`, {
    headers: { Authorization: `Bearer ${seller.accessToken}` },
  });
  expect(ownRoute.status).toBe(200);
  const ownRouteBody = await ownRoute.json() as {
    route: {
      routeId: string;
      executionVersion: number;
      stops: Array<{ routeVersionStopId: string; status: string }>;
    };
  };
  expect(ownRouteBody).toMatchObject({
    availability: 'available',
    route: {
      routeId: publishedRouteId,
      executionVersion: expect.any(Number),
      seller: { id: seller.id },
      status: 'published',
    },
  });
  expect(ownRoute.headers.get('cache-control')).toContain('no-store');

  const emptyRoute = await fetch(`${origin}/api/v1/me/routes/today`, {
    headers: { Authorization: `Bearer ${sellerB.accessToken}` },
  });
  expect(emptyRoute.status).toBe(200);
  expect(await emptyRoute.json()).toMatchObject({ availability: 'empty' });

  const hiddenRoute = await fetch(`${origin}/api/v1/routes/${publishedRouteId}`, {
    headers: { Authorization: `Bearer ${sellerB.accessToken}` },
  });
  expect(hiddenRoute.status).toBe(404);
  expect(JSON.stringify(await hiddenRoute.json())).not.toMatch(/seller|client|scope/i);

  const managerRoute = await fetch(`${origin}/api/v1/routes/${publishedRouteId}`, {
    headers: { Authorization: `Bearer ${manager.accessToken}` },
  });
  expect(managerRoute.status).toBe(200);
  expect(await managerRoute.json()).toMatchObject({ routeId: publishedRouteId, status: 'published' });

  const forbiddenComposition = await fetch(`${origin}/api/v1/routes/${publishedRouteId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${seller.accessToken}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  expect(forbiddenComposition.status).toBe(403);
  const missingIdempotency = await fetch(`${origin}/api/v1/routes/${publishedRouteId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${manager.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      schemaVersion: 1,
      expectedVersion: ownRouteBody.route.executionVersion,
      reason: 'Teste sem chave idempotente',
      stops: [
        { clientId: '10000000-0000-4000-8000-000000000002', plannedOrder: 1, priority: 0 },
        { clientId: '10000000-0000-4000-8000-000000000003', plannedOrder: 2, priority: 1 },
      ],
    }),
  });
  expect(missingIdempotency.status).toBe(422);
  const staleComposition = await fetch(`${origin}/api/v1/routes/${publishedRouteId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${manager.accessToken}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': crypto.randomUUID(),
    },
    body: JSON.stringify({
      schemaVersion: 1,
      expectedVersion: 1,
      reason: 'Teste de versao obsoleta',
      stops: [
        { clientId: '10000000-0000-4000-8000-000000000002', plannedOrder: 1, priority: 0 },
        { clientId: '10000000-0000-4000-8000-000000000003', plannedOrder: 2, priority: 1 },
      ],
    }),
  });
  expect(staleComposition.status).toBe(409);
  expect(staleComposition.headers.get('cache-control')).toContain('no-store');

  const compositionHeaders = {
    Authorization: `Bearer ${manager.accessToken}`,
    'Content-Type': 'application/json',
  };
  const compositionCommands = [
    [
      { clientId: '10000000-0000-4000-8000-000000000001', plannedOrder: 1, priority: 1 },
      { clientId: '10000000-0000-4000-8000-000000000003', plannedOrder: 2, priority: 0 },
    ],
    [
      { clientId: '10000000-0000-4000-8000-000000000001', plannedOrder: 1, priority: 0 },
      { clientId: '10000000-0000-4000-8000-000000000002', plannedOrder: 2, priority: 1 },
    ],
  ];
  const competingCompositions = await Promise.all(compositionCommands.map((stops, index) => (
    fetch(`${origin}/api/v1/routes/${publishedRouteId}`, {
      method: 'PATCH',
      headers: { ...compositionHeaders, 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({
        schemaVersion: 1,
        expectedVersion: ownRouteBody.route.executionVersion,
        reason: `Ajuste concorrente sintetico ${index + 1}`,
        stops,
      }),
    })
  )));
  expect(competingCompositions.map(({ status }) => status).sort()).toEqual([200, 409]);
  const acceptedComposition = competingCompositions.find(({ status }) => status === 200)!;
  const rejectedComposition = competingCompositions.find(({ status }) => status === 409)!;
  expect(await rejectedComposition.json()).toMatchObject({ error: { code: 'VERSION_CONFLICT' } });
  const acceptedCompositionBody = await acceptedComposition.json() as { expectedVersion: number };
  const successorPublication = await fetch(`${origin}/api/v1/routes/${publishedRouteId}/publish`, {
    method: 'POST',
    headers: compositionHeaders,
    body: JSON.stringify({ schemaVersion: 1, expectedVersion: acceptedCompositionBody.expectedVersion }),
  });
  expect(successorPublication.status).toBe(200);
  const revisedDailyRoute = await fetch(`${origin}/api/v1/me/routes/today`, {
    headers: { Authorization: `Bearer ${seller.accessToken}` },
  });
  expect(revisedDailyRoute.status).toBe(200);
  expect(await revisedDailyRoute.json()).toMatchObject({
    route: { executionVersion: acceptedCompositionBody.expectedVersion + 1 },
  });
  // Reordering requires two pending stops. Keep the daily visits intact and exercise
  // the same HTTP contract on a dedicated future route instead of resetting executions.
  if (!/^[0-9a-f-]{36}$/i.test(seller.id)) throw new Error('Invalid synthetic seller UUID');
  const nextDate = await exec(dockerProgram, [...dockerPrefix, 'exec', 'supabase_db_cirne-rotas-dev',
    'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres', '-c',
    `select (coalesce(max(service_date), date '2399-12-31') + 1)::text from api.routes
      where seller_id = '${seller.id}' and service_date >= date '2400-01-01' and service_date < date '2500-01-01'`],
  { windowsHide: true, timeout: 25_000 });
  const reorderDraftResponse = await fetch(`${origin}/api/v1/routes`, {
    method: 'POST', headers: compositionHeaders,
    body: JSON.stringify({ schemaVersion: 1, sellerId: seller.id,
      serviceDate: nextDate.stdout.trim(), stops: compositionCommands[0] }),
  });
  expect(reorderDraftResponse.status).toBe(201);
  const reorderDraft = await reorderDraftResponse.json() as { routeId: string; expectedVersion: number };
  const reorderRouteId = reorderDraft.routeId;
  const reorderPublication = await fetch(`${origin}/api/v1/routes/${reorderRouteId}/publish`, {
    method: 'POST', headers: compositionHeaders,
    body: JSON.stringify({ schemaVersion: 1, expectedVersion: reorderDraft.expectedVersion }),
  });
  expect(reorderPublication.status).toBe(200);
  const operationalRoute = await fetch(`${origin}/api/v1/routes/${reorderRouteId}`, {
    headers: { Authorization: `Bearer ${seller.accessToken}` },
  });
  expect(operationalRoute.status).toBe(200);
  const operationalRouteBody = { route: await operationalRoute.json() } as typeof ownRouteBody;
  expect(operationalRouteBody.route.executionVersion).toBe(reorderDraft.expectedVersion + 1);
  expect(operationalRouteBody.route.stops.filter(({ status }) => status === 'pending')).toHaveLength(2);

  const competingOrder = [...operationalRouteBody.route.stops]
    .filter(({ status }) => status === 'pending')
    .reverse()
    .map(({ routeVersionStopId }) => routeVersionStopId);
  const reorderBody = JSON.stringify({
    schemaVersion: 1,
    expectedVersion: operationalRouteBody.route.executionVersion,
    pendingStopIds: competingOrder,
  });
  for (const [accessToken, body, expectedStatus] of [
    [sellerB.accessToken, reorderBody, 404],
    [seller.accessToken, '{}', 422],
    [seller.accessToken, JSON.stringify({ schemaVersion: 1,
      expectedVersion: operationalRouteBody.route.executionVersion,
      pendingStopIds: [competingOrder[0], competingOrder[0]] }), 422],
  ] as const) {
    const rejected = await fetch(`${origin}/api/v1/routes/${reorderRouteId}/execution-order`, {
      method: 'PUT', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body,
    });
    expect(rejected.status).toBe(expectedStatus);
    expect(rejected.headers.get('cache-control')).toContain('no-store');
  }
  const [sellerReorder, managerReorder] = await Promise.all([
    fetch(`${origin}/api/v1/routes/${reorderRouteId}/execution-order`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${seller.accessToken}`, 'Content-Type': 'application/json' },
      body: reorderBody,
    }),
    fetch(`${origin}/api/v1/routes/${reorderRouteId}/execution-order`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${manager.accessToken}`, 'Content-Type': 'application/json' },
      body: reorderBody,
    }),
  ]);
  expect([sellerReorder.status, managerReorder.status].sort()).toEqual([200, 409]);
  const successfulReorder = sellerReorder.ok ? sellerReorder : managerReorder;
  const conflictedReorder = sellerReorder.ok ? managerReorder : sellerReorder;
  expect(await successfulReorder.json()).toMatchObject({
    changed: true, executionVersion: operationalRouteBody.route.executionVersion + 1,
  });
  expect(await conflictedReorder.json()).toMatchObject({ error: { code: 'VERSION_CONFLICT' } });
  const confirmed = await fetch(`${origin}/api/v1/routes/${reorderRouteId}`, {
    headers: { Authorization: `Bearer ${seller.accessToken}` },
  });
  expect(confirmed.status).toBe(200);
  const confirmedBody = await confirmed.json() as {
    executionVersion: number; stops: Array<{ routeVersionStopId: string }>;
  };
  expect(confirmedBody.executionVersion).toBe(operationalRouteBody.route.executionVersion + 1);
  expect(confirmedBody.stops.map((stop) => stop.routeVersionStopId)).toEqual(competingOrder);
  const uppercaseNoOp = await fetch(`${origin}/api/v1/routes/${reorderRouteId.toUpperCase()}/execution-order`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${seller.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ schemaVersion: 1, expectedVersion: confirmedBody.executionVersion,
      pendingStopIds: competingOrder.map((id) => id.toUpperCase()) }),
  });
  expect(uppercaseNoOp.status).toBe(200);
  expect(await uppercaseNoOp.json()).toMatchObject({
    changed: false, executionVersion: confirmedBody.executionVersion, pendingStopIds: competingOrder,
  });

  const stalePublication = await fetch(`${origin}/api/v1/routes/${publishedRouteId}/publish`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${manager.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ schemaVersion: 1, expectedVersion: 1 }),
  });
  expect(stalePublication.status).toBe(409);

  const forbiddenCreate = await fetch(`${origin}/api/v1/routes`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${seller.accessToken}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  expect(forbiddenCreate.status).toBe(403);
  expect(output).not.toMatch(/Cliente Sintético|Endereço sintético|CARTEIRA-SINTETICA/i);
});

it('runs the real visit API through the CLI with canonical idempotent confirmation', async () => {
  const seller = actorManifest.actors.seller_a;
  const administrator = actorManifest.actors.administrator;
  if (!seller) throw new Error('Synthetic seller missing');
  if (!administrator || !/^[0-9a-f-]{36}$/i.test(administrator.id)) {
    throw new Error('Synthetic administrator missing');
  }
  const catalogSql = `begin;
    grant cirne_visit_executor to postgres with set true granted by current_user;
    set local role cirne_visit_executor;
    do $catalog$
    begin
      if not exists (select 1 from api.parameter_sets where id = '90000000-0000-4000-8000-000000000002') then
        insert into api.parameter_sets (id, version, status, valid_from)
        values ('90000000-0000-4000-8000-000000000002', 2, 'draft', '2026-01-02T00:00:00Z');
        insert into api.parameter_values (id, parameter_set_id, category, code, label, sort_order) values
          ('c2000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000002', 'competitor', 'synthetic_competitor', 'Concorrente Sintético', 1),
          ('c2000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000002', 'competitor_price_technology', 'synthetic_technology', 'Tecnologia Sintética', 1),
          ('c2000000-0000-4000-8000-000000000003', '90000000-0000-4000-8000-000000000002', 'competitor_price_condition', 'synthetic_condition', 'Condição Sintética', 1),
          ('c2000000-0000-4000-8000-000000000004', '90000000-0000-4000-8000-000000000002', 'competitor_price_unavailable_reason', 'synthetic_unavailable', 'Motivo Sintético', 1);
      end if;
      update api.parameter_sets set status = 'retired' where status = 'published';
      update api.parameter_sets set status = 'published', published_at = clock_timestamp(),
        published_by = '${administrator.id}' where id = '90000000-0000-4000-8000-000000000002';
    end
    $catalog$;
    reset role;
    revoke cirne_visit_executor from postgres granted by current_user;
    commit;`;
  const catalogResetSql = `begin;
    grant cirne_visit_executor to postgres with set true granted by current_user;
    set local role cirne_visit_executor;
    update api.parameter_sets set status = 'retired'
      where id = '90000000-0000-4000-8000-000000000002' and status = 'published';
    update api.parameter_sets set status = 'published'
      where id = '90000000-0000-4000-8000-000000000001';
    reset role;
    revoke cirne_visit_executor from postgres granted by current_user;
    commit;`;
  await exec(dockerProgram, [...dockerPrefix, 'exec', 'supabase_db_cirne-rotas-dev',
    'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres', '-c', catalogSql],
  { windowsHide: true, timeout: 25_000 });
  let result: Awaited<ReturnType<typeof runWithClosedInput>>;
  try {
    result = await runWithClosedInput(process.execPath, [
      '--import', 'tsx', 'apps/cli/src/visits-cli.ts', '--url', origin, '--json',
    ], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        CIRNE_ACCESS_TOKEN: seller.accessToken,
      },
    });
  } finally {
    await exec(dockerProgram, [...dockerPrefix, 'exec', 'supabase_db_cirne-rotas-dev',
      'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres', '-c', catalogResetSql],
    { windowsHide: true, timeout: 25_000 });
  }
  expect(JSON.parse(result.stdout)).toMatchObject({
    status: 'ok',
    visitStatus: 'in_progress',
    checks: {
      started: true,
      replayMatched: true,
      divergentRejected: true,
      canonicalContext: true,
      stockSaved: true,
      stockReplayMatched: true,
      stockDivergentRejected: true,
    },
  });
  expect(result.stdout + result.stderr).not.toContain(seller.accessToken);
  expect(result.stdout + result.stderr).not.toMatch(
    /routeVersionStopId|offlineId|deviceId|eventId|idempotencyKey|latitude|longitude|payload/i,
  );
});

it('enforces sync BFF authorization and preserves independent partial progress', async () => {
  const seller = actorManifest.actors.seller_a;
  const manager = actorManifest.actors.manager_a;
  if (!seller || !manager) throw new Error('Synthetic actors missing');
  const deviceId = crypto.randomUUID();
  const failedAggregateId = crypto.randomUUID();
  const independentAggregateId = crypto.randomUUID();
  const makeCommand = (aggregateId: string, sequence: number) => ({
    eventId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
    operation: 'visit.draft.saved',
    schemaVersion: 1,
    sequence,
    aggregateType: 'visit_draft',
    aggregateId,
    occurredAt: new Date().toISOString(),
    payload: {
      draftOfflineId: aggregateId,
      routeVersionStopId: '44444444-4444-4444-8444-444444444441',
      acknowledged: true,
    },
  });
  const events = [makeCommand(failedAggregateId, 2), makeCommand(independentAggregateId, 1)];
  const headers = {
    Authorization: `Bearer ${seller.accessToken}`,
    'Content-Type': 'application/json',
  };

  const partial = await fetch(`${origin}/api/v1/sync/batches`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ deviceId, events }),
  });
  expect(partial.status).toBe(200);
  expect(await partial.json()).toMatchObject({
    results: [
      { eventId: events[0]!.eventId, status: 'rejected', error: { code: 'EVENT_OUT_OF_ORDER' } },
      { eventId: events[1]!.eventId, status: 'confirmed' },
    ],
  });
  expect(partial.headers.get('cache-control')).toContain('no-store');

  const forbidden = await fetch(`${origin}/api/v1/sync/batches`, {
    method: 'POST',
    headers: { ...headers, Authorization: `Bearer ${manager.accessToken}` },
    body: JSON.stringify({ deviceId, events: [makeCommand(crypto.randomUUID(), 1)] }),
  });
  expect(forbidden.status).toBe(403);

  const unsupported = await fetch(`${origin}/api/v1/sync/batches`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'text/plain' },
    body: '{}',
  });
  expect(unsupported.status).toBe(415);

  const duplicate = makeCommand(crypto.randomUUID(), 1);
  const invalidBatch = await fetch(`${origin}/api/v1/sync/batches`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ deviceId, events: [duplicate, { ...duplicate, sequence: 2 }] }),
  });
  expect(invalidBatch.status).toBe(422);
  expect(output).not.toMatch(/draftOfflineId|routeVersionStopId|acknowledged/);
});

it('refuses startup with an invalid required configuration without leaking its value', async () => {
  const invalidPort = await freePort();
  try {
    await exec(process.execPath, [path.join(root, 'scripts/start-web.mjs')], {
      cwd: path.join(root, 'apps/web'), windowsHide: true, timeout: 15000,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PORT: String(invalidPort), NODE_ENV: 'production', APP_BASE_URL: 'synthetic-secret-invalid-url', NEXT_TELEMETRY_DISABLED: '1' },
    });
    throw new Error('Server incorrectly accepted invalid configuration');
  } catch (error) {
    expect(error).toMatchObject({ code: 1 });
    const failure = error as { stdout: string; stderr: string };
    expect(failure.stderr).toContain('Configuração inválida: APP_BASE_URL');
    expect(failure.stdout + failure.stderr).not.toContain('synthetic-secret-invalid-url');
  }
});
