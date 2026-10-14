import { parseArgs } from 'node:util';
import { runClientImportRoundTrip } from './client-imports';

async function stdin() { let value = ''; if (!process.stdin.isTTY) for await (const chunk of process.stdin) value += chunk; return value.trim(); }

try {
  const { values } = parseArgs({ options: {
    url: { type: 'string', default: 'http://127.0.0.1:3000' },
    file: { type: 'string' }, json: { type: 'boolean' },
  }, strict: true });
  if (!values.file) throw new Error('Informe --file CAMINHO.xlsx.');
  const token = process.env.CIRNE_MANAGER_ACCESS_TOKEN?.trim() || await stdin();
  if (!token) throw new Error('Forneça o token do Gestor por stdin ou CIRNE_MANAGER_ACCESS_TOKEN.');
  const result = await runClientImportRoundTrip(values.url, token, values.file);
  console.log(values.json ? JSON.stringify(result) : `OK: lote ${result.batchId}, ${result.acceptedCount} aceitos, ${result.rejectedCount} rejeitados; replay confirmado.`);
} catch (error) {
  const message = error instanceof Error ? error.message : 'Falha na importação de clientes.';
  console.error(process.argv.includes('--json') ? JSON.stringify({ status: 'error', message }) : message);
  process.exitCode = 1;
}
