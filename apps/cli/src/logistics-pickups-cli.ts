import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { runLogisticsPickupCommand, LogisticsPickupCliError } from './logistics-pickups';

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, strict: true, options: {
    url: { type: 'string', default: 'http://127.0.0.1:3000' }, date: { type: 'string' },
    'schedule-id': { type: 'string' }, 'idempotency-key': { type: 'string' }, file: { type: 'string' },
    json: { type: 'boolean', default: true },
  } });
  const operation = z.enum(['list', 'operators', 'assignment', 'result', 'correction', 'review']).safeParse(positionals[0]);
  if (!operation.success || positionals.length !== 1) {
    throw new LogisticsPickupCliError(64, 'Use list --date AAAA-MM-DD, operators ou assignment/result/correction/review --schedule-id UUID --idempotency-key UUID --file comando.json.');
  }
  let token = process.env.CIRNE_ACCESS_TOKEN?.trim() || process.env.CIRNE_MANAGER_ACCESS_TOKEN?.trim();
  if (!token && !process.stdin.isTTY) {
    let input = ''; for await (const chunk of process.stdin) input += chunk;
    token = input.trim();
  }
  if (!token) throw new LogisticsPickupCliError(77, 'Forneça token autorizado por stdin ou CIRNE_ACCESS_TOKEN.');
  const mutation = operation.data !== 'list' && operation.data !== 'operators';
  if (mutation && !values.file) throw new LogisticsPickupCliError(64, 'Informe --file com o comando JSON.');
  let body: unknown;
  if (values.file) {
    try { body = JSON.parse(await readFile(values.file, 'utf8')); }
    catch { throw new LogisticsPickupCliError(64, 'Arquivo de comando JSON inválido.'); }
  }
  const result = await runLogisticsPickupCommand({ baseUrl: values.url, token, operation: operation.data,
    date: values.date, scheduleId: values['schedule-id'], idempotencyKey: values['idempotency-key'], body });
  console.log(JSON.stringify(result, null, values.json ? undefined : 2));
} catch (error) {
  const failure = error instanceof LogisticsPickupCliError ? error : new LogisticsPickupCliError(64, 'Argumentos da CLI inválidos.');
  console.error(JSON.stringify({ schemaVersion: 1, status: 'error', message: failure.message }));
  process.exitCode = failure.exitCode;
}
