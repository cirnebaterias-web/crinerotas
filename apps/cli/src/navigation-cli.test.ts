import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('runs a real CLI process using synthetic data without opening Maps', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'apps/cli/src/navigation-cli.ts', '--json'], { encoding: 'utf8' });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ status: 'ok', synthetic: true, networkRequests: 0,
    checks: { encodedAddress: true, coordinates: true, invalidCoordinatesFallback: true, emptyRejected: true } });
});

it('rejects unknown arguments without echoing their values', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'apps/cli/src/navigation-cli.ts', '--json', '--token=do-not-log'], { encoding: 'utf8' });
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stderr).status).toBe('error');
  expect(result.stderr + result.stdout).not.toContain('do-not-log');
});
