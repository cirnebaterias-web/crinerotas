import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { clientSheetSyncRequestSchema } from '@cirne/contracts';
import { clientSheetSyncCommand, loginSheetSyncOperator } from './client-sheet-sync';

try {
  const { values } = parseArgs({ options: { url: { type: 'string', default: process.env.APP_BASE_URL ?? 'http://127.0.0.1:3000' },
    status: { type: 'boolean' }, scheduled: { type: 'boolean' }, key: { type: 'string' }, json: { type: 'boolean' } }, strict: true });
  if (values.status && values.scheduled) throw new Error('Use --status ou --scheduled, não ambos.');
  if (values.key && (values.status || values.scheduled)) throw new Error('--key é exclusivo de atualização manual.');
  let token = process.env.CIRNE_MANAGER_ACCESS_TOKEN?.trim();
  if (values.scheduled || (!token && process.env.CIRNE_SHEET_SYNC_EMAIL)) token = await loginSheetSyncOperator(process.env);
  if (!token && !process.stdin.isTTY) {
    let input = '';
    for await (const chunk of process.stdin) input += chunk.toString();
    token = input.trim();
  }
  if (!token) throw new Error('Forneça token por stdin/CIRNE_MANAGER_ACCESS_TOKEN ou configure a identidade técnica.');
  const command = values.status ? null : clientSheetSyncRequestSchema.parse(values.scheduled
    ? { trigger: 'scheduled' } : { trigger: 'manual', idempotencyKey: values.key ?? randomUUID() });
  const result = await clientSheetSyncCommand(values.url, token, command);
  console.log(JSON.stringify(result));
  if ('status' in result && result.status === 'failed') process.exitCode = 1;
} catch (error) {
  // Do not print SDK errors/Zod input payloads containing external values or secrets.
  const message = error instanceof Error && error.constructor === Error ? error.message : 'Falha na atualização. Confira os argumentos e a conexão.';
  console.error(JSON.stringify({ status: 'error', message }));
  process.exitCode = 1;
}
