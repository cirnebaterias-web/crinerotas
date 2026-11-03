import {
  administrationSnapshotSchema,
  updateAdministrationUserRequestSchema,
  updateAdministrationUserResultSchema,
  type AdministrationSnapshot,
  type MeResponse,
  type UpdateAdministrationUserRequest,
  type UpdateAdministrationUserResult,
} from '@cirne/contracts';
import { RouteServiceFailure, publicRouteMessage } from '../routes/service';

export interface AdministrationRepository {
  getSnapshot(): Promise<AdministrationSnapshot>;
  updateUser(userId: string, command: UpdateAdministrationUserRequest,
    origin: 'web' | 'cli'): Promise<UpdateAdministrationUserResult>;
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
) {
  requireAdministrationAccess(identity);
  const parsed = administrationSnapshotSchema.safeParse(await repository.getSnapshot());
  if (!parsed.success) {
    throw new RouteServiceFailure(
      'DEPENDENCY_UNAVAILABLE', publicRouteMessage('DEPENDENCY_UNAVAILABLE'), true,
    );
  }
  return parsed.data;
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
