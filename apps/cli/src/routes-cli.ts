import { parseArgs } from 'node:util';
import { selectRouteTokens } from './route-input';
import { runRouteRoundTrip } from './routes';

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
  const tokens = selectRouteTokens(
    process.env.CIRNE_MANAGER_ACCESS_TOKEN,
    process.env.CIRNE_SELLER_ACCESS_TOKEN,
    await readStandardInput(),
  );
  const result = await runRouteRoundTrip(
    values.url,
    tokens.managerAccessToken,
    tokens.sellerAccessToken,
  );
  console.log(json ? JSON.stringify(result) :
    `OK: rota ${result.routeId} v${result.routeVersion}/execução ${result.executionVersion} publicada, carregada e ` +
    `${result.checks.reordered === 'applied' ? 'reordenada' : 'já canônica'} com ${result.stopCount} paradas.`);
} catch (error) {
  const message = error instanceof Error && !('code' in error)
    ? error.message
    : 'Argumentos inválidos. Use --url ORIGEM e --json; forneça ambos os tokens por stdin ou ambiente.';
  console.error(json ? JSON.stringify({ status: 'error', message }) : message);
  process.exitCode = 1;
}
