import {
  managementMapResponseSchema,
  managementServiceDateSchema,
  type ManagementMapResponse,
  type MeResponse,
} from '@cirne/contracts';
import { publicRouteMessage, RouteServiceFailure } from '../routes/service';

export interface ManagementMapRepository {
  getForDate(serviceDate: string): Promise<ManagementMapResponse>;
}

export function requireManagementMapAccess(identity: MeResponse) {
  if (identity.status !== 'active' || !identity.roles.includes('manager') ||
      !identity.capabilities.includes('route.read_scoped') || identity.scopeIds.length === 0) {
    throw new RouteServiceFailure('FORBIDDEN', publicRouteMessage('FORBIDDEN'), false);
  }
}

export async function getManagementMap(
  identity: MeResponse,
  serviceDate: string,
  repository: ManagementMapRepository,
) {
  requireManagementMapAccess(identity);
  const parsedDate = managementServiceDateSchema.safeParse(serviceDate);
  if (!parsedDate.success) {
    throw new RouteServiceFailure('VALIDATION_FAILED', 'Data operacional inválida.', false);
  }
  const parsed = managementMapResponseSchema.safeParse(await repository.getForDate(parsedDate.data));
  if (!parsed.success || parsed.data.serviceDate !== parsedDate.data) {
    throw new RouteServiceFailure('DEPENDENCY_UNAVAILABLE', publicRouteMessage('DEPENDENCY_UNAVAILABLE'), true);
  }
  return parsed.data;
}
