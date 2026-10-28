import { parseArgs } from 'node:util';
import { runVisitDetailCommand, VisitDetailCliError } from './visit-detail';

async function stdin() {
  let value = '';
  if (!process.stdin.isTTY) for await (const chunk of process.stdin) value += chunk;
  return value.trim();
}

try {
  const { values } = parseArgs({
    options: {
      url: { type: 'string', default: 'http://127.0.0.1:3000' },
      'visit-id': { type: 'string' },
      json: { type: 'boolean', default: false },
    },
    strict: true,
  });
  const token = process.env.CIRNE_MANAGER_ACCESS_TOKEN?.trim() || await stdin();
  if (!token) throw new VisitDetailCliError(77, 'Forneça o token do Gestor por stdin ou CIRNE_MANAGER_ACCESS_TOKEN.');
  const result = await runVisitDetailCommand({
    baseUrl: values.url, token, visitId: values['visit-id'], json: values.json,
  });
  console.log(result.output);
  process.exitCode = result.exitCode;
} catch (error) {
  const parseError = error instanceof Error && 'code' in error &&
    typeof error.code === 'string' && error.code.startsWith('ERR_PARSE_ARGS_');
  const failure = error instanceof VisitDetailCliError ? error
    : parseError ? new VisitDetailCliError(64, 'Os argumentos informados são inválidos.')
      : new VisitDetailCliError(69, 'Não foi possível consultar o detalhe da visita.');
  console.error(process.argv.includes('--json')
    ? JSON.stringify({ schemaVersion: 1, status: 'error', message: failure.message })
    : failure.message);
  process.exitCode = failure.exitCode;
}
