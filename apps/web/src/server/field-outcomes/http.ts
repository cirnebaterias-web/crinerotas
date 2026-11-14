import { z } from 'zod';
import type { MeResponse } from '@cirne/contracts';
import { RouteRequestError } from '@/server/routes/http';

export function requireSeller(identity: MeResponse, capability: string) {
  if (!identity.roles.includes('seller') || !identity.capabilities.includes(capability)) {
    throw new RouteRequestError(403, 'FORBIDDEN', 'Operação não autorizada.', false);
  }
}
export function requireUuid(value: string | null, label = 'Identificador') {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) throw new RouteRequestError(422, 'VALIDATION_FAILED', `${label} inválido.`, false);
  return parsed.data;
}
export function requireMutationHeaders(request: Request) {
  return {
    deviceId: requireUuid(request.headers.get('x-device-id'), 'Dispositivo'),
    idempotencyKey: requireUuid(request.headers.get('idempotency-key'), 'Chave idempotente'),
  };
}
