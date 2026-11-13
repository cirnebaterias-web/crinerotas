import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('validates the offline catalog generator with synthetic workbook fixtures', () => {
  const result = execFileSync('python', [fileURLToPath(new URL('./test_product_catalog_cli.py', import.meta.url))], {
    encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, stdio: 'pipe', timeout: 80_000,
  });
  expect(result).toBe('');
// The fixtures exercise repeated Python CLI processes, including failure paths.
}, 90_000);
