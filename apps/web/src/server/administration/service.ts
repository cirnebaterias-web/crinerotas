import {
  administrationSnapshotSchema,
  createAdministrationUserRequestSchema, createAdministrationUserResultSchema,
  resetAdministrationPasswordRequestSchema, resetAdministrationPasswordResultSchema,
  updateAdministrationUserRequestSchema,
  updateAdministrationUserResultSchema,
  type AdministrationSnapshot,
  type MeResponse,
  type UpdateAdministrationUserRequest,
  type UpdateAdministrationUserResult,
  type CreateAdministrationUserRequest, type CreateAdministrationUserResult,
  type ResetAdministrationPasswordRequest, type ResetAdministrationPasswordResult,
} from '@cirne/contracts';
import { RouteServiceFailure, publicRouteMessage } from '../routes/service';
import type { AdministrationAuthGateway } from './auth-admin';

export interface AdministrationRepository {
  getSnapshot(): Promise<AdministrationSnapshot>;
  updateUser(userId: string, command: UpdateAdministrationUserRequest,
    origin: 'web' | 'cli'): Promise<UpdateAdministrationUserResult>;
  createUser?(userId: string, command: CreateAdministrationUserRequest,
    origin: 'web' | 'cli'): Promise<CreateAdministrationUserResult>;
  authorizePasswordReset?(userId: string, command: ResetAdministrationPasswordRequest,
    origin: 'web' | 'cli'): Promise<ResetAdministrationPasswordResult & { state: 'pending' | 'completed' }>;
  completePasswordReset?(userId: string, idempotencyKey: string,
    origin: 'web' | 'cli'): Promise<ResetAdministrationPasswordResult & { state: 'completed' }>;
}

export function requireAdministrationAccess(identity: MeResponse) {
  if (!identity.roles.includes('administrator') ||
      !identity.capabilities.includes('identity.manage')) {
    throw new RouteServiceFailure('FORBIDDEN', publicRouteMessage('FORBIDDEN'), false);
  }
}

export async function getAdministrationSnapshot(
  identity: MeResponse,
  repository: AdministrationRepository,
  auth?: AdministrationAuthGateway,
) {
  requireAdministrationAccess(identity);
  const parsed = administrationSnapshotSchema.safeParse(await repository.getSnapshot());
  if (!parsed.success) {
    throw new RouteServiceFailure(
      'DEPENDENCY_UNAVAILABLE', publicRouteMessage('DEPENDENCY_UNAVAILABLE'), true,
    );
  }
  if (!auth) return parsed.data;
  const users = await auth.listUsers();
  const byId = new Map(users.map((user) => [user.id, user]));
  return { ...parsed.data, users: parsed.data.users.map((user) => {
    const authUser = byId.get(user.id);
    return { ...user, auth: authUser ? { email: authUser.email, emailConfirmed: authUser.emailConfirmed,
      lastSignInAt: authUser.lastSignInAt } : null };
  }) };
}

export async function createAdministrationUser(identity: MeResponse, command: CreateAdministrationUserRequest,
  origin: 'web' | 'cli', repository: AdministrationRepository, auth: AdministrationAuthGateway) {
  requireAdministrationAccess(identity);
  const parsed = createAdministrationUserRequestSchema.safeParse(command);
  if (!parsed.success) throw new RouteServiceFailure('VALIDATION_FAILED', 'Revise os dados do novo acesso.', false);
  let authUser: Awaited<ReturnType<AdministrationAuthGateway['createUser']>>;
  if (!repository.createUser) throw new RouteServiceFailure('DEPENDENCY_UNAVAILABLE', publicRouteMessage('DEPENDENCY_UNAVAILABLE'), true);
  try { authUser = await auth.createUser(parsed.data); }
  catch { throw new RouteServiceFailure('VERSION_CONFLICT', 'Este email ja possui acesso ou nao pode ser provisionado.', false); }
  try {
    const result = createAdministrationUserResultSchema.parse(
      await repository.createUser(authUser.id, parsed.data, origin),
    );
    return { ...result, user: { ...result.user, auth: { email: authUser.email,
      emailConfirmed: authUser.emailConfirmed, lastSignInAt: authUser.lastSignInAt } } };
  } catch (error) {
    if (authUser.created) await auth.deleteUser(authUser.id).catch(() => undefined);
    if (error instanceof RouteServiceFailure) throw error;
    throw new RouteServiceFailure('DEPENDENCY_UNAVAILABLE', publicRouteMessage('DEPENDENCY_UNAVAILABLE'), true);
  }
}

export async function resetAdministrationPassword(identity: MeResponse, userId: string,
  command: ResetAdministrationPasswordRequest, origin: 'web' | 'cli', repository: AdministrationRepository,
  auth: AdministrationAuthGateway) {
  requireAdministrationAccess(identity);
  if (identity.id === userId) throw new RouteServiceFailure('FORBIDDEN', publicRouteMessage('FORBIDDEN'), false);
  const parsed = resetAdministrationPasswordRequestSchema.safeParse(command);
  if (!parsed.success) throw new RouteServiceFailure('VALIDATION_FAILED', 'Revise a nova senha temporaria.', false);
  const target = (await repository.getSnapshot()).users.find((user) => user.id === userId);
  if (!target || target.status !== 'active') {
    throw new RouteServiceFailure('NOT_FOUND', 'Usuario ativo nao encontrado.', false);
  }
  if (!repository.authorizePasswordReset || !repository.completePasswordReset) {
    throw new RouteServiceFailure('DEPENDENCY_UNAVAILABLE', publicRouteMessage('DEPENDENCY_UNAVAILABLE'), true);
  }
  const authorization = await repository.authorizePasswordReset(userId, parsed.data, origin);
  if (authorization.state === 'completed') {
    return { schemaVersion: 1 as const, replayed: true, userId };
  }
  try { await auth.updatePassword(userId, parsed.data.password); }
  catch { throw new RouteServiceFailure('DEPENDENCY_UNAVAILABLE', 'Nao foi possivel redefinir a senha agora.', true); }
  const completed = await repository.completePasswordReset(userId, parsed.data.idempotencyKey, origin);
  const result = resetAdministrationPasswordResultSchema.safeParse({ schemaVersion: completed.schemaVersion,
    replayed: completed.replayed, userId: completed.userId });
  if (!result.success || result.data.userId !== userId) {
    throw new RouteServiceFailure('DEPENDENCY_UNAVAILABLE', publicRouteMessage('DEPENDENCY_UNAVAILABLE'), true);
  }
  return result.data;
}

export async function updateAdministrationUser(
  identity: MeResponse,
  userId: string,
  command: UpdateAdministrationUserRequest,
  origin: 'web' | 'cli',
  repository: AdministrationRepository,
) {
  requireAdministrationAccess(identity);
  if (identity.id === userId) {
    throw new RouteServiceFailure('FORBIDDEN', publicRouteMessage('FORBIDDEN'), false);
  }
  const parsedCommand = updateAdministrationUserRequestSchema.safeParse(command);
  if (!parsedCommand.success) {
    throw new RouteServiceFailure('VALIDATION_FAILED', 'Revise os dados administrativos.', false);
  }
  const parsedResult = updateAdministrationUserResultSchema.safeParse(
    await repository.updateUser(userId, parsedCommand.data, origin),
  );
  if (!parsedResult.success || parsedResult.data.user.id !== userId) {
    throw new RouteServiceFailure(
      'DEPENDENCY_UNAVAILABLE', publicRouteMessage('DEPENDENCY_UNAVAILABLE'), true,
    );
  }
  return parsedResult.data;
}
