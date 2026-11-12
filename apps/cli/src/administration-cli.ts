import { parseArgs } from 'node:util';
import { z } from 'zod';
import { createAdministrationUserRequestSchema, resetAdministrationPasswordRequestSchema,
  updateAdministrationUserRequestSchema } from '@cirne/contracts';
import {
  AdministrationCliError, createAdministrationAccess, formatAdministration, loadAdministration,
  mutateAdministrationUser, resetAdministrationAccessPassword,
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
    create: { type: 'boolean', default: false }, email: { type: 'string' }, name: { type: 'string' },
    'reset-password': { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  }, strict: true });
  const token = process.env.CIRNE_ADMIN_ACCESS_TOKEN?.trim() || await stdin();
  if (!token) throw new AdministrationCliError(77,
    'Forneca o token do Administrador por stdin ou CIRNE_ADMIN_ACCESS_TOKEN.');

  const password = process.env.CIRNE_ADMIN_PASSWORD?.trim();
  if (values.create) {
    const command = createAdministrationUserRequestSchema.safeParse({ schemaVersion: 1,
      displayName: values.name, email: values.email, password,
      roles: values.roles?.split(',').map((item) => item.trim()).filter(Boolean), reason: values.reason,
      idempotencyKey: crypto.randomUUID() });
    if (!command.success) throw new AdministrationCliError(64,
      'Para criar, informe --create --name --email --roles --reason e CIRNE_ADMIN_PASSWORD.');
    const result = await createAdministrationAccess(values.url, token, command.data);
    console.log(values.json ? JSON.stringify({ ...result, temporaryPassword: undefined })
      : `OK: acesso criado para ${result.user.displayName}.`);
  } else if (values['reset-password']) {
    const command = resetAdministrationPasswordRequestSchema.safeParse({ schemaVersion: 1,
      password, reason: values.reason, idempotencyKey: crypto.randomUUID() });
    if (!values.user || !command.success) throw new AdministrationCliError(64,
      'Para redefinir, informe --reset-password --user --reason e CIRNE_ADMIN_PASSWORD.');
    const result = await resetAdministrationAccessPassword(values.url, token, values.user, command.data);
    console.log(values.json ? JSON.stringify(result) : `OK: senha redefinida para ${result.userId}.`);
  } else if (!values.user) {
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
