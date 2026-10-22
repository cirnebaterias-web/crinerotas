import {
  managementDayResponseSchema,
  managementServiceDateSchema,
  type ManagementDayResponse,
  type MeResponse,
} from '@cirne/contracts';
import { RouteServiceFailure, publicRouteMessage } from '../routes/service';

export type ManagementClock = { now(): Date };

export interface ManagementDayRepository {
  getForDate(serviceDate: string, operationalTimeZone: string): Promise<ManagementDayResponse>;
}

export function requireManagementDayAccess(identity: MeResponse) {
  if (!identity.roles.includes('manager') ||
      !identity.capabilities.includes('route.read_scoped') ||
      identity.scopeIds.length === 0) {
    throw new RouteServiceFailure('FORBIDDEN', publicRouteMessage('FORBIDDEN'), false);
  }
}

export function managementCurrentDate(
  operationalTimeZone: string,
  clock: ManagementClock = { now: () => new Date() },
) {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: operationalTimeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(clock.now());
  } catch {
    throw new RouteServiceFailure('DEPENDENCY_UNAVAILABLE', publicRouteMessage('DEPENDENCY_UNAVAILABLE'), true);
  }
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return managementServiceDateSchema.parse(`${values.year}-${values.month}-${values.day}`);
}

export async function getManagementDay(
  identity: MeResponse,
  serviceDate: string,
  operationalTimeZone: string,
  repository: ManagementDayRepository,
) {
  requireManagementDayAccess(identity);
  const parsed = managementServiceDateSchema.safeParse(serviceDate);
  if (!parsed.success) {
    throw new RouteServiceFailure('VALIDATION_FAILED', 'Data operacional inválida.', false);
  }
  const result = managementDayResponseSchema.safeParse(
    await repository.getForDate(parsed.data, operationalTimeZone),
  );
  if (!result.success || result.data.serviceDate !== parsed.data) {
    throw new RouteServiceFailure('DEPENDENCY_UNAVAILABLE', publicRouteMessage('DEPENDENCY_UNAVAILABLE'), true);
  }
  return result.data;
}
