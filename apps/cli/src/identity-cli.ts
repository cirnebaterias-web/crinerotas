import { parseArgs } from 'node:util';
import { checkIdentity } from './identity';
import { selectIdentityToken } from './identity-input';

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
  const stdin = await readStandardInput();
  const token = selectIdentityToken(process.env.CIRNE_ACCESS_TOKEN, stdin);
  const result = await checkIdentity(values.url, token);
  console.log(json ? JSON.stringify(result) :
    `OK: ${result.displayName}; papéis: ${result.roles.join(', ')}; capacidades: ${result.capabilities.join(', ')}.`);
} catch (error) {
  const message = error instanceof Error && !('code' in error)
    ? error.message
    : 'Argumentos inválidos. Use --url ORIGEM e --json; forneça o token por stdin ou ambiente.';
  console.error(json ? JSON.stringify({ status: 'error', message }) : message);
  process.exitCode = 1;
}
