import { parseArgs } from 'node:util';
import { PilotMetricsCliError, runPilotMetricsCommand } from './pilot-metrics';

async function stdin() {
  let value = '';
  if (!process.stdin.isTTY) for await (const chunk of process.stdin) value += chunk;
  return value.trim();
}

try {
  const { values } = parseArgs({
    options: {
      url: { type: 'string', default: 'http://127.0.0.1:3000' },
      from: { type: 'string' }, to: { type: 'string' },
      'seller-id': { type: 'string' }, 'client-id': { type: 'string' },
      cursor: { type: 'string' }, json: { type: 'boolean', default: false },
    },
    strict: true,
  });
  const token = process.env.CIRNE_MANAGER_ACCESS_TOKEN?.trim() || await stdin();
  if (!token) throw new PilotMetricsCliError(77, 'Forneça o token do Gestor por stdin ou CIRNE_MANAGER_ACCESS_TOKEN.');
  const result = await runPilotMetricsCommand({
    baseUrl: values.url,
    token,
    values: {
      from: values.from, to: values.to,
      sellerId: values['seller-id'], clientId: values['client-id'], cursor: values.cursor,
    },
    timeZone: process.env.OPERATIONAL_TIME_ZONE?.trim() || 'America/Recife',
    json: values.json,
  });
  console.log(result.output);
  process.exitCode = result.exitCode;
} catch (error) {
  const parseError = error instanceof Error && 'code' in error &&
    typeof error.code === 'string' && error.code.startsWith('ERR_PARSE_ARGS_');
  const failure = error instanceof PilotMetricsCliError
    ? error
    : parseError
      ? new PilotMetricsCliError(64, 'Os argumentos informados são inválidos.')
      : new PilotMetricsCliError(69, 'Não foi possível consultar as métricas do piloto.');
  console.error(process.argv.includes('--json')
    ? JSON.stringify({ schemaVersion: 1, status: 'error', message: failure.message })
    : failure.message);
  process.exitCode = failure.exitCode;
}
