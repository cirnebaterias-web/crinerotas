import { parseArgs } from 'node:util';
import { selectIdentityToken } from './identity-input';
import { runVisitRoundTrip } from './visits';

const json = process.argv.includes('--json');

async function readStandardInput() {
  if (process.stdin.isTTY) return '';
  let value = '';
  for await (const chunk of process.stdin) value += chunk.toString();
  return value;
}

try {
  const { values } = parseArgs({
    options: {
      url: { type: 'string', default: 'http://127.0.0.1:3000' },
      json: { type: 'boolean' },
    },
    strict: true,
  });
  const token = selectIdentityToken(process.env.CIRNE_ACCESS_TOKEN, await readStandardInput());
  const result = await runVisitRoundTrip(values.url, token);
  console.log(json ? JSON.stringify(result) :
    `OK: visita ${result.visitId}, estoque e preços sintéticos reconhecidos sem duplicidade.`);
} catch (error) {
  const parseArgsFailure = error instanceof Error && 'code' in error &&
    typeof error.code === 'string' && error.code.startsWith('ERR_PARSE_ARGS_');
  const message = parseArgsFailure || !(error instanceof Error)
    ? 'Argumentos inválidos. Use --url ORIGEM e --json; forneça o token por stdin ou ambiente.'
    : error.message;
  console.error(json ? JSON.stringify({ status: 'error', message }) : message);
  process.exitCode = 1;
}
