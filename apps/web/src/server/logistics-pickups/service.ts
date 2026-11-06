import { z } from 'zod';
import {
  assignLogisticsPickupSchema, correctLogisticsPickupSchema, recordLogisticsPickupSchema,
  reviewLogisticsPickupSchema, logisticsPickupDateSchema, logisticsPickupListSchema,
  logisticsPickupRecordSchema, logisticsOperatorListSchema,
  type LogisticsPickupAction, type MeResponse,
} from '@cirne/contracts';
import { RouteRequestError } from '../routes/http';

export interface LogisticsPickupRepository {
  list(date: string): Promise<unknown>;
  operators(): Promise<unknown>;
  change(scheduleId: string, operation: LogisticsPickupAction, idempotencyKey: string, command: unknown): Promise<unknown>;
}

export function requireLogisticsPickupAccess(identity: MeResponse, operation: 'read' | 'manage' | 'execute') {
  const manager = identity.capabilities.includes('scrap.dispatch_pickups') &&
    (identity.roles.includes('administrator') || (identity.roles.includes('manager') && identity.scopeIds.length > 0));
  const operator = identity.roles.includes('logistics') && identity.capabilities.includes('scrap.execute_pickups');
  if (identity.status !== 'active' || !(operation === 'read' ? manager || operator : operation === 'manage' ? manager : operator)) {
    throw new RouteRequestError(403, 'FORBIDDEN', 'Operação de logística não autorizada.', false);
  }
}

function validate<T>(schema: { safeParse(input: unknown): { success: true; data: T } | { success: false } }, input: unknown, response = false): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new RouteRequestError(response ? 503 : 422,
    response ? 'DEPENDENCY_UNAVAILABLE' : 'VALIDATION_FAILED',
    response ? 'Logística temporariamente indisponível.' : 'Revise os dados da operação de logística.', response);
  return parsed.data;
}

export async function listLogisticsPickups(identity: MeResponse, date: unknown, repository: LogisticsPickupRepository) {
  requireLogisticsPickupAccess(identity, 'read');
  return validate(logisticsPickupListSchema, await repository.list(validate(logisticsPickupDateSchema, date)), true);
}

export async function listLogisticsOperators(identity: MeResponse, repository: LogisticsPickupRepository) {
  requireLogisticsPickupAccess(identity, 'manage');
  return validate(logisticsOperatorListSchema, await repository.operators(), true);
}

export async function changeLogisticsPickup(identity: MeResponse, scheduleId: unknown, operation: unknown,
  idempotencyKey: unknown, body: unknown, repository: LogisticsPickupRepository) {
  const action = validate(z.enum(['assignment', 'result', 'correction', 'review']), operation);
  requireLogisticsPickupAccess(identity, action === 'result' ? 'execute' : 'manage');
  const id = validate(z.uuid(), scheduleId);
  const key = validate(z.uuid(), idempotencyKey);
  const command = action === 'assignment' ? validate(assignLogisticsPickupSchema, body)
    : action === 'result' ? validate(recordLogisticsPickupSchema, body)
      : action === 'correction' ? validate(correctLogisticsPickupSchema, body)
        : validate(reviewLogisticsPickupSchema, body);
  return validate(logisticsPickupRecordSchema, await repository.change(id, action, key, command), true);
}
