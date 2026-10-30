import { parseArgs } from 'node:util';
import { z } from 'zod';
import { updateAdministrationUserRequestSchema } from '@cirne/contracts';
import {
  AdministrationCliError, formatAdministration, loadAdministration, mutateAdministrationUser,
} from './administration';

async function stdin() {
  let value = '';
  if (!process.stdin.isTTY) for await (const chunk of process.stdin) value += chunk;
  return value.trim();
}

try {
  const { values } = parseArgs({ options: {
    url: { type: 'string', default: 'http://127.0.0.1:3000' },
    user: { type: 'string' }, status: { type: 'string' }, roles: { type: 'string' },
    'seller-scopes': { type: 'string' }, reason: { type: 'string' },
    'expected-updated-at': { type: 'string' },
    json: { type: 'boolean', default: false },
  }, strict: true });
  const token = process.env.CIRNE_ADMIN_ACCESS_TOKEN?.trim() || await stdin();
  if (!token) throw new AdministrationCliError(77,
    'Forneca o token do Administrador por stdin ou CIRNE_ADMIN_ACCESS_TOKEN.');

  if (!values.user) {
    const snapshot = await loadAdministration(values.url, token);
    console.log(values.json ? JSON.stringify(snapshot) : formatAdministration(snapshot));
  } else {
    const roles = values.roles?.split(',').map((item) => item.trim()).filter(Boolean);
    const sellerScopeIds = values['seller-scopes']?.split(',').map((item) => item.trim()).filter(Boolean) ?? [];
    const command = updateAdministrationUserRequestSchema.safeParse({
      schemaVersion: 1, expectedUpdatedAt: values['expected-updated-at'], status: values.status,
      roles, sellerScopeIds, reason: values.reason, idempotencyKey: crypto.randomUUID(),
    });
    if (!z.uuid().safeParse(values.user).success || !command.success) {
      throw new AdministrationCliError(64,
        'Para alterar, informe --user, --status, --roles, --reason e --expected-updated-at validos.');
    }
    const result = await mutateAdministrationUser(values.url, token, values.user, command.data);
    console.log(values.json ? JSON.stringify(result)
      : `OK: ${result.user.displayName} atualizado; replay=${result.replayed}.`);
  }
} catch (error) {
  const parseError = error instanceof Error && 'code' in error &&
    typeof error.code === 'string' && error.code.startsWith('ERR_PARSE_ARGS_');
  const failure = error instanceof AdministrationCliError ? error
    : parseError ? new AdministrationCliError(64, 'Os argumentos informados sao invalidos.')
      : new AdministrationCliError(69, 'Nao foi possivel concluir a administracao.');
  console.error(process.argv.includes('--json')
    ? JSON.stringify({ schemaVersion: 1, status: 'error', message: failure.message }) : failure.message);
  process.exitCode = failure.exitCode;
}
