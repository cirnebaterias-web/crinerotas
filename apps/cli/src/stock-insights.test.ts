import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { stockInsightsSchema } from '@cirne/contracts';
import { diagnoseStockInsights } from './stock-insights';

describe('stock insights CLI', () => {
  it('returns structured diagnostics with no plausible analysis for invalid input', () => {
    const result = diagnoseStockInsights({ snapshot: { ownLines: [{ quantity: -3 }] }, catalogs: [], publishedCatalogVersion: 2 });
    expect(result).toMatchObject({ status: 'error', code: 'VALIDATION_FAILED', issues: expect.any(Array) });
    expect(result).not.toHaveProperty('analysis');
  });
  it('runs the shared offline catalog in a real deterministic process', () => {
    const run = () => spawnSync(process.execPath, ['--import', 'tsx', 'apps/cli/src/stock-insights-cli.ts', '--snapshot', 'tests/fixtures/stock-insights-snapshot.json', '--json'], { encoding: 'utf8', timeout: 30_000 });
    const result = run();
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
    expect(stockInsightsSchema.parse(JSON.parse(result.stdout)).overall.ownSharePercent).toBe(40);
    expect(run().stdout).toBe(result.stdout);
  }, 75_000);
  it('exits nonzero for unreadable/invalid snapshots and arguments without echoing values', () => {
    for (const args of [['--snapshot', 'package.json'], ['--snapshot', 'missing-synthetic.json'], ['--token=do-not-echo']]) {
      const result = spawnSync(process.execPath, ['--import', 'tsx', 'apps/cli/src/stock-insights-cli.ts', ...args], { encoding: 'utf8', timeout: 30_000 });
      expect(result.status).toBe(1); expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toMatchObject({ status: 'error' });
      expect(result.stderr).not.toContain('do-not-echo');
    }
  }, 110_000);
  it('accepts an explicit versioned catalog JSON without using the bundled catalog', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'apps/cli/src/stock-insights-cli.ts',
      '--snapshot', 'tests/fixtures/stock-insights-snapshot.json', '--catalog', 'tests/fixtures/stock-insights-catalogs.json'],
    { encoding: 'utf8', timeout: 30_000 });
    expect(result.status).toBe(0);
    const analysis = stockInsightsSchema.parse(JSON.parse(result.stdout));
    expect(analysis.opportunities[0]!.models.map((model) => model.code)).toEqual(['synthetic-h60']);
    expect(analysis.opportunities[1]!.models).toEqual([]);
  }, 40_000);
});
