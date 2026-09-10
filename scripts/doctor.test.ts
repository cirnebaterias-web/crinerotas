import { createServer } from 'node:net';
import { expect, it, vi } from 'vitest';
import { diagnose, portAvailable, supportedVersion } from './doctor';
import { configuredPorts } from './local-settings';

it('reports missing dependencies and port conflicts, without raw command output', async () => {
  const checks = await diagnose(vi.fn().mockResolvedValue({ ok: false, output: 'secret-token' }), [3000], 'win32', async () => false);
  expect(checks.some((check) => check.name === 'docker' && !check.ok)).toBe(true);
  expect(checks.some((check) => check.name === 'wsl2' && !check.ok)).toBe(true);
  expect(checks.at(-1)).toMatchObject({ name: 'port:3000', ok: false });
  expect(JSON.stringify(checks)).not.toContain('secret-token');
});

it('reports an available WSL2 distribution without a failure hint', async () => {
  const checks = await diagnose(async (command) => command === 'wsl.exe'
    ? { ok: true, output: 'Ubuntu              Running         2' }
    : { ok: true, output: '24.19.0' }, [], 'win32');
  expect(checks.find((check) => check.name === 'wsl2')).toEqual({
    name: 'wsl2',
    ok: true,
    detail: 'Distribuição WSL2 disponível.',
  });
});

it('detects a real occupied loopback port and releases probes', async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP server');
  try { expect(await portAvailable(address.port)).toBe(false); }
  finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  expect(await portAvailable(address.port)).toBe(true);
});

it('reads configured service ports and validates the web port', () => {
  expect(configuredPorts('3100')).toEqual(expect.arrayContaining([3100, 54321, 54322, 54323, 54324, 54320]));
  expect(() => configuredPorts('secret')).toThrow('CIRNE_WEB_PORT inválida');
});

it('checks numeric versions without accepting older versions or prereleases', () => {
  for (const v of ['24.18.9', '25.0.0', '24.19.0-rc.1', undefined]) expect(supportedVersion(v, 24, 19)).toBe(false);
  for (const v of ['24.19.0', '24.20.1', '24.100.0']) expect(supportedVersion(v, 24, 19)).toBe(true);
});
