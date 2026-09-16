import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { promisify } from 'node:util';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { root, run, supabaseBinary } from '../../scripts/process';

const exec = promisify(execFile);
let server: ChildProcess | undefined;
let origin: string;
let output = '';
let identityEnvironment: { SUPABASE_PUBLIC_URL: string; SUPABASE_PUBLISHABLE_KEY: string };
let actorManifest: {
  actors: Record<string, { id: string; accessToken: string }>;
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
    capabilities: ['identity.read_self', 'route.read_self', 'route.reorder_self', 'sync.write_self'],
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
    route?: { executionVersion: number; stops: Array<{ plannedOrder: number }> };
  };
  const alreadyCanonical = before.route?.stops[0]?.plannedOrder === 3;
  const expectedExecutionVersion = (before.route?.executionVersion ?? 2) + (alreadyCanonical ? 0 : 1);
  const result = await runWithClosedInput(process.execPath, cliArguments, cliOptions);
  const body = JSON.parse(result.stdout) as {
    routeId: string;
    stopCount: number;
    executionVersion: number;
    checks: { reordered: string };
  };
  publishedRouteId = body.routeId;
  expect(body).toMatchObject({
    status: 'ok',
    routeVersion: 1,
    executionVersion: expectedExecutionVersion,
    routeStatus: 'published',
    stopCount: 2,
    checks: { created: true, published: true, loadedBySeller: true,
      reordered: alreadyCanonical ? 'already_canonical' : 'applied' },
  });
  expect(result.stdout + result.stderr).not.toContain(manager.accessToken);
  expect(result.stdout + result.stderr).not.toContain(seller.accessToken);
  expect(result.stdout + result.stderr).not.toMatch(/Cliente Sintético|Endereço sintético|snapshot/i);

  const repeated = await runWithClosedInput(process.execPath, cliArguments, cliOptions);
  expect(JSON.parse(repeated.stdout)).toEqual({
    ...body,
    checks: { ...body.checks, reordered: 'already_canonical' },
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

  const competingOrder = [...ownRouteBody.route.stops]
    .filter(({ status }) => status === 'pending')
    .reverse()
    .map(({ routeVersionStopId }) => routeVersionStopId);
  const reorderBody = JSON.stringify({
    schemaVersion: 1,
    expectedVersion: ownRouteBody.route.executionVersion,
    pendingStopIds: competingOrder,
  });
  for (const [accessToken, body, expectedStatus] of [
    [sellerB.accessToken, reorderBody, 404],
    [seller.accessToken, '{}', 422],
    [seller.accessToken, JSON.stringify({ schemaVersion: 1,
      expectedVersion: ownRouteBody.route.executionVersion,
      pendingStopIds: [competingOrder[0], competingOrder[0]] }), 422],
  ] as const) {
    const rejected = await fetch(`${origin}/api/v1/routes/${publishedRouteId}/execution-order`, {
      method: 'PUT', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body,
    });
    expect(rejected.status).toBe(expectedStatus);
    expect(rejected.headers.get('cache-control')).toContain('no-store');
  }
  const [sellerReorder, managerReorder] = await Promise.all([
    fetch(`${origin}/api/v1/routes/${publishedRouteId}/execution-order`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${seller.accessToken}`, 'Content-Type': 'application/json' },
      body: reorderBody,
    }),
    fetch(`${origin}/api/v1/routes/${publishedRouteId}/execution-order`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${manager.accessToken}`, 'Content-Type': 'application/json' },
      body: reorderBody,
    }),
  ]);
  expect([sellerReorder.status, managerReorder.status].sort()).toEqual([200, 409]);
  const successfulReorder = sellerReorder.ok ? sellerReorder : managerReorder;
  const conflictedReorder = sellerReorder.ok ? managerReorder : sellerReorder;
  expect(await successfulReorder.json()).toMatchObject({
    changed: true, executionVersion: ownRouteBody.route.executionVersion + 1,
  });
  expect(await conflictedReorder.json()).toMatchObject({ error: { code: 'VERSION_CONFLICT' } });
  const confirmed = await fetch(`${origin}/api/v1/routes/${publishedRouteId}`, {
    headers: { Authorization: `Bearer ${seller.accessToken}` },
  });
  expect(confirmed.status).toBe(200);
  const confirmedBody = await confirmed.json() as {
    executionVersion: number; stops: Array<{ routeVersionStopId: string }>;
  };
  expect(confirmedBody.executionVersion).toBe(ownRouteBody.route.executionVersion + 1);
  expect(confirmedBody.stops.map((stop) => stop.routeVersionStopId)).toEqual(competingOrder);

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
  try {
    await exec(process.execPath, [path.join(root, 'scripts/start-web.mjs')], {
      cwd: path.join(root, 'apps/web'), windowsHide: true, timeout: 15000,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PORT: '3000', NODE_ENV: 'production', APP_BASE_URL: 'synthetic-secret-invalid-url', NEXT_TELEMETRY_DISABLED: '1' },
    });
    throw new Error('Server incorrectly accepted invalid configuration');
  } catch (error) {
    expect(error).toMatchObject({ code: 1 });
    const failure = error as { stdout: string; stderr: string };
    expect(failure.stderr).toContain('Configuração inválida: APP_BASE_URL');
    expect(failure.stdout + failure.stderr).not.toContain('synthetic-secret-invalid-url');
  }
});
