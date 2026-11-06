import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { salesSyncRequestSchema } from '@cirne/contracts';
import { loginSalesSyncOperator, salesSyncCommand } from './sales-sync';

try {
  const { values } = parseArgs({ options: { url: { type: 'string', default: process.env.APP_BASE_URL ?? 'http://127.0.0.1:3000' },
    status: { type: 'boolean' }, scheduled: { type: 'boolean' }, key: { type: 'string' }, json: { type: 'boolean' } }, strict: true });
  if ((values.status && values.scheduled) || (values.key && (values.status || values.scheduled))) throw new Error();
  const token = await loginSalesSyncOperator(process.env);
  const command = values.status ? null : salesSyncRequestSchema.parse(values.scheduled
    ? { trigger: 'scheduled' } : { trigger: 'manual', idempotencyKey: values.key ?? randomUUID() });
  // Print the manual key before work so an interrupted operator can recover the same intention.
  if (command?.trigger === 'manual') console.error(JSON.stringify({ status: 'starting', idempotencyKey: command.idempotencyKey }));
  const result = await salesSyncCommand(values.url, token, command);
  console.log(JSON.stringify(result));
  if ('status' in result && result.status !== 'published') process.exitCode = result.status === 'collecting' ? 2 : 1;
} catch {
  console.error(JSON.stringify({ status: 'error', message: 'Importação de vendas não concluída. Confira configuração, argumentos e estado; preserve a chave da intenção para recuperação.' }));
  process.exitCode = 1;
}
