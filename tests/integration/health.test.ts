import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { root } from '../../scripts/process';

const exec = promisify(execFile);
let server: ChildProcess;
let origin: string;
let output = '';

async function freePort() {
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const address = socket.address();
  if (!address || typeof address === 'string') throw new Error('No TCP address');
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return address.port;
}

beforeAll(async () => {
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [path.join(root, 'scripts/start-web.mjs')], {
    cwd: path.join(root, 'apps/web'), windowsHide: true,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PORT: String(port), NODE_ENV: 'production', APP_BASE_URL: origin, LOG_LEVEL: 'info', NEXT_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.on('data', (chunk) => { output += String(chunk); });
  server.stderr?.on('data', (chunk) => { output += String(chunk); });
  const deadline = Date.now() + 50000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Server exited before readiness: ${output}`);
    try { if ((await fetch(`${origin}/api/v1/health/live`, { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* readiness polling */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Server did not start: ${output}`);
});

afterAll(async () => {
  if (server && server.exitCode === null) {
    const stopped = new Promise<void>((resolve) => server.once('exit', () => resolve()));
    server.kill();
    await stopped;
  }
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
  const port = await freePort();
  await expect(exec(process.execPath, ['--import', 'tsx', 'apps/cli/src/index.ts', '--url', `http://127.0.0.1:${port}`, '--json'], { cwd: root, windowsHide: true })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('inacessível') });
});

it('refuses startup with an invalid required configuration without leaking its value', async () => {
  const port = await freePort();
  try {
    await exec(process.execPath, [path.join(root, 'scripts/start-web.mjs')], {
      cwd: path.join(root, 'apps/web'), windowsHide: true, timeout: 15000,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PORT: String(port), NODE_ENV: 'production', APP_BASE_URL: 'synthetic-secret-invalid-url', NEXT_TELEMETRY_DISABLED: '1' },
    });
    throw new Error('Server incorrectly accepted invalid configuration');
  } catch (error) {
    expect(error).toMatchObject({ code: 1 });
    const failure = error as { stdout: string; stderr: string };
    expect(failure.stderr).toContain('Configuração inválida: APP_BASE_URL');
    expect(failure.stdout + failure.stderr).not.toContain('synthetic-secret-invalid-url');
  }
});
