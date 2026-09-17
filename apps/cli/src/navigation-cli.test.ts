import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

// A real Node/tsx process can start slowly on a busy Windows host. Bound the
// child independently so a hung command cannot block the worker indefinitely.
const processOptions = { encoding: 'utf8', timeout: 30_000 } as const;
const processTestTimeout = 40_000;

it('runs a real CLI process using synthetic data without opening Maps', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'apps/cli/src/navigation-cli.ts', '--json'], processOptions);
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ status: 'ok', synthetic: true, networkRequests: 0,
    checks: { encodedAddress: true, coordinates: true, invalidCoordinatesFallback: true, emptyRejected: true } });
}, processTestTimeout);

it('rejects unknown arguments without echoing their values', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'apps/cli/src/navigation-cli.ts', '--json', '--token=do-not-log'], processOptions);
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stderr)).toEqual({
    status: 'error',
    message: 'Diagnóstico inválido. Use apenas --json.',
  });
  expect(result.stderr + result.stdout).not.toContain('do-not-log');
}, processTestTimeout);
