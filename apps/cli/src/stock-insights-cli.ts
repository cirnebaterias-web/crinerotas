import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { supportedStockInsightsCatalogs } from '@cirne/domain';
import { diagnoseStockInsights } from './stock-insights';

try {
  const { values } = parseArgs({ options: {
    snapshot: { type: 'string' }, catalog: { type: 'string' }, json: { type: 'boolean' },
  }, strict: true, allowPositionals: false });
  if (!values.snapshot) throw new Error('ARGUMENTS_INVALID');
  const snapshot: unknown = JSON.parse(await readFile(values.snapshot, 'utf8'));
  const registry: unknown = values.catalog
    ? JSON.parse(await readFile(values.catalog, 'utf8')) : supportedStockInsightsCatalogs;
  const result = diagnoseStockInsights({
    ...(typeof registry === 'object' && registry !== null ? registry : {}), snapshot,
  });
  if (result.status === 'error') { console.error(JSON.stringify(result)); process.exitCode = 1; }
  else console.log(JSON.stringify(result.analysis));
} catch {
  console.error(JSON.stringify({ status: 'error', code: 'INPUT_UNREADABLE',
    message: 'Use --snapshot arquivo.json e, opcionalmente, --catalog catalogos.json; ambos devem ser JSON válido.' }));
  process.exitCode = 1;
}
