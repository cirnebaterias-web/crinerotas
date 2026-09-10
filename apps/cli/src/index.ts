import { parseArgs } from 'node:util';
import { checkLive } from './health';

const json = process.argv.includes('--json');
try {
  const { values } = parseArgs({ options: { url: { type: 'string', default: 'http://127.0.0.1:3000' }, json: { type: 'boolean' } }, strict: true });
  const result = await checkLive(values.url);
  console.log(json ? JSON.stringify(result) : 'OK: processo da aplicação responde. Banco não é verificado por live.');
} catch (error) {
  const message = error instanceof Error && !('code' in error) ? error.message : 'Argumentos inválidos. Use --url ORIGEM e --json.';
  console.error(json ? JSON.stringify({ status: 'error', message }) : message);
  process.exitCode = 1;
}
