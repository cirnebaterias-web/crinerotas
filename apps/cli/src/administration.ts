import {
  administrationPath,
  administrationSnapshotSchema,
  administrationUserPath,
  administrationUserPasswordPath, createAdministrationUserRequestSchema,
  createAdministrationUserResultSchema, resetAdministrationPasswordRequestSchema,
  resetAdministrationPasswordResultSchema,
  apiErrorResponseSchema,
  updateAdministrationUserRequestSchema,
  updateAdministrationUserResultSchema,
  type AdministrationSnapshot,
  type UpdateAdministrationUserRequest,
  type CreateAdministrationUserRequest, type ResetAdministrationPasswordRequest,
} from '@cirne/contracts';
import { z } from 'zod';

export const administrationExitCodes = {
  success: 0, invalidArgument: 64, dependencyFailure: 69, accessDenied: 77, conflict: 78,
} as const;

export class AdministrationCliError extends Error {
  constructor(public readonly exitCode: number, message: string) { super(message); }
}

async function administrationRequest(
  baseUrl: string,
  token: string,
  path: string,
  init: RequestInit = {},
  request: typeof fetch = fetch,
) {
  let response: Response;
  try {
    response = await request(new URL(path, baseUrl), {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
      cache: 'no-store', signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new AdministrationCliError(69, 'Administracao temporariamente indisponivel.');
  }
  const body = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    const parsed = apiErrorResponseSchema.safeParse(body);
    const exitCode = response.status === 401 || response.status === 403 ? 77
      : response.status === 409 ? 78
        : response.status === 400 || response.status === 422 ? 64 : 69;
    throw new AdministrationCliError(exitCode,
      parsed.success ? parsed.data.error.message : 'Administracao temporariamente indisponivel.');
  }
  return body;
}

export async function loadAdministration(
  baseUrl: string, token: string, request: typeof fetch = fetch,
) {
  const body = await administrationRequest(baseUrl, token, administrationPath, {}, request);
  const parsed = administrationSnapshotSchema.safeParse(body);
  if (!parsed.success) throw new AdministrationCliError(69, 'Resposta administrativa invalida.');
  return parsed.data;
}

export async function mutateAdministrationUser(
  baseUrl: string,
  token: string,
  userId: string,
  command: UpdateAdministrationUserRequest,
  request: typeof fetch = fetch,
) {
  const parsedUserId = z.uuid().safeParse(userId.toLowerCase());
  const parsedCommand = updateAdministrationUserRequestSchema.safeParse(command);
  if (!parsedUserId.success || !parsedCommand.success) {
    throw new AdministrationCliError(64, 'Comando administrativo invalido.');
  }
  const normalizedUserId = parsedUserId.data;
  const body = await administrationRequest(baseUrl, token, administrationUserPath(normalizedUserId), {
    method: 'PUT', body: JSON.stringify(parsedCommand.data),
  }, request);
  const parsed = updateAdministrationUserResultSchema.safeParse(body);
  if (!parsed.success || parsed.data.user.id !== normalizedUserId) {
    throw new AdministrationCliError(69, 'Resposta administrativa invalida.');
  }
  return parsed.data;
}

export async function createAdministrationAccess(baseUrl: string, token: string,
  command: CreateAdministrationUserRequest, request: typeof fetch = fetch) {
  const parsed = createAdministrationUserRequestSchema.safeParse(command);
  if (!parsed.success) throw new AdministrationCliError(64, 'Novo acesso invalido.');
  const body = await administrationRequest(baseUrl, token, administrationPath, {
    method: 'POST', headers: { 'x-csrf-token': 'cirne-route-v1', 'x-cirne-origin': 'cli' },
    body: JSON.stringify(parsed.data),
  }, request);
  const result = createAdministrationUserResultSchema.safeParse(body);
  if (!result.success) throw new AdministrationCliError(69, 'Resposta administrativa invalida.');
  return result.data;
}

export async function resetAdministrationAccessPassword(baseUrl: string, token: string, userId: string,
  command: ResetAdministrationPasswordRequest, request: typeof fetch = fetch) {
  const id = z.uuid().safeParse(userId.toLowerCase());
  const parsed = resetAdministrationPasswordRequestSchema.safeParse(command);
  if (!id.success || !parsed.success) throw new AdministrationCliError(64, 'Redefinicao invalida.');
  const body = await administrationRequest(baseUrl, token, administrationUserPasswordPath(id.data), {
    method: 'POST', headers: { 'x-csrf-token': 'cirne-route-v1', 'x-cirne-origin': 'cli' },
    body: JSON.stringify(parsed.data),
  }, request);
  const result = resetAdministrationPasswordResultSchema.safeParse(body);
  if (!result.success || result.data.userId !== id.data) throw new AdministrationCliError(69, 'Resposta administrativa invalida.');
  return result.data;
}

export function formatAdministration(snapshot: AdministrationSnapshot) {
  const active = snapshot.users.filter((user) => user.status === 'active').length;
  const lines = [
    `Administracao: ${snapshot.users.length} usuario(s), ${active} ativo(s).`,
    'ID | Status | Papeis | Nome',
    ...snapshot.users.map((user) =>
      `${user.id} | ${user.status} | ${user.roles.join(',')} | ${user.displayName}`),
  ];
  const current = snapshot.parameters.current;
  lines.push(current
    ? `Parametros publicados: versao ${current.version}, ${current.values.length} valor(es).`
    : 'Parametros publicados: nenhum conjunto vigente.');
  lines.push(`Edicao de parametros bloqueada por: ${snapshot.parameters.blockers.join(', ')}.`);
  return lines.join('\n');
}
