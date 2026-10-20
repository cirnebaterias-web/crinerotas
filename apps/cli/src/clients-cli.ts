import { parseArgs } from 'node:util';
import { runClientManagementRoundTrip } from './clients';

async function stdin() {
  let value = '';
  if (!process.stdin.isTTY) for await (const chunk of process.stdin) value += chunk;
  return value.trim();
}
try {
  const { values } = parseArgs({
    options: {
      url: { type: 'string', default: 'http://127.0.0.1:3000' },
      'seller-email': { type: 'string' },
      json: { type: 'boolean' },
    },
    strict: true,
  });
  if (!values['seller-email']) throw new Error('Informe --seller-email vendedor@example.invalid.');
  const token = process.env.CIRNE_MANAGER_ACCESS_TOKEN?.trim() || await stdin();
  if (!token) throw new Error('Forneça o token do Gestor por stdin ou CIRNE_MANAGER_ACCESS_TOKEN.');
  const result = await runClientManagementRoundTrip(values.url, token, values['seller-email']);
  console.log(values.json ? JSON.stringify(result) :
    `OK: cliente ${result.clientId}; criação, consulta, correção, replay e conflito confirmados.`);
} catch (error) {
  const message = error instanceof Error ? error.message : 'Falha na manutenção de clientes.';
  console.error(process.argv.includes('--json') ? JSON.stringify({ schemaVersion: 1, status: 'error', message }) : message);
  process.exitCode = 1;
}
