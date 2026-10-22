import { parseArgs } from 'node:util';
import { ManagementDayCliError, runManagementDayCommand } from './management-day';

async function stdin() {
  let value = '';
  if (!process.stdin.isTTY) for await (const chunk of process.stdin) value += chunk;
  return value.trim();
}

try {
  const { values } = parseArgs({
    options: {
      url: { type: 'string', default: 'http://127.0.0.1:3000' },
      date: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
    strict: true,
  });
  const token = process.env.CIRNE_MANAGER_ACCESS_TOKEN?.trim() || await stdin();
  if (!token) throw new ManagementDayCliError(77, 'Forneça o token do Gestor por stdin ou CIRNE_MANAGER_ACCESS_TOKEN.');
  const timeZone = process.env.OPERATIONAL_TIME_ZONE?.trim() || 'America/Recife';
  const result = await runManagementDayCommand({
    baseUrl: values.url,
    token,
    date: values.date,
    timeZone,
    json: values.json,
  });
  console.log(result.output);
  process.exitCode = result.exitCode;
} catch (error) {
  const parseError = error instanceof Error && 'code' in error &&
    typeof error.code === 'string' && error.code.startsWith('ERR_PARSE_ARGS_');
  const failure = error instanceof ManagementDayCliError
    ? error
    : parseError
      ? new ManagementDayCliError(64, 'Os argumentos informados são inválidos.')
      : new ManagementDayCliError(69, 'Não foi possível consultar a visão gerencial.');
  const json = process.argv.includes('--json');
  console.error(json
    ? JSON.stringify({ schemaVersion: 1, status: 'error', message: failure.message })
    : failure.message);
  process.exitCode = failure.exitCode;
}
