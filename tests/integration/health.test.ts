import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { promisify } from 'node:util';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { root } from '../../scripts/process';

const exec = promisify(execFile);
let server: ChildProcess | undefined;
let origin: string;
let output = '';

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

beforeAll(async () => {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const port = await freePort();
    const candidateOrigin = `http://127.0.0.1:${port}`;
    const candidate = spawn(process.execPath, [path.join(root, 'scripts/start-web.mjs')], {
      cwd: path.join(root, 'apps/web'), windowsHide: true,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PORT: String(port), NODE_ENV: 'production', APP_BASE_URL: candidateOrigin, LOG_LEVEL: 'info', NEXT_TELEMETRY_DISABLED: '1' },
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
