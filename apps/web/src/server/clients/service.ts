import { z } from 'zod';
import {
  clientDetailSchema,
  clientMutationResponseSchema,
  clientSellerListResponseSchema,
  type CreateClientRequest,
  type UpdateClientRequest,
} from '@cirne/contracts';
import type { SupabaseClient } from '@supabase/supabase-js';
import { clientImportRpc } from '../client-imports/http';
import { parseBearer } from '../identity';
import { RouteRequestError } from '../routes/http';

export function clientRequestOrigin(request: Request): 'web' | 'cli' {
  return parseBearer(request.headers.get('authorization')) ? 'cli' : 'web';
}
export function requireClientId(value: string) {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) {
    throw new RouteRequestError(422, 'VALIDATION_FAILED', 'Identificador de cliente inválido.', false);
  }
  return parsed.data;
}

export function requireClientIdempotencyKey(request: Request) {
  const parsed = z.uuid().safeParse(request.headers.get('idempotency-key'));
  if (!parsed.success) {
    throw new RouteRequestError(422, 'VALIDATION_FAILED', 'Idempotency-Key UUID obrigatória.', false);
  }
  return parsed.data;
}

export async function createManagedClient(
  client: SupabaseClient,
  command: CreateClientRequest,
  idempotencyKey: string,
  origin: 'web' | 'cli',
) {
  return clientMutationResponseSchema.parse(await clientImportRpc(client, 'create_client', {
    p_command: command, p_idempotency_key: idempotencyKey, p_origin: origin,
  }));
}

export async function getManagedClient(client: SupabaseClient, clientId: string) {
  return clientDetailSchema.parse(await clientImportRpc(client, 'get_client', { p_client_id: clientId }));
}

export async function updateManagedClient(
  client: SupabaseClient,
  clientId: string,
  command: UpdateClientRequest,
  idempotencyKey: string,
  origin: 'web' | 'cli',
) {
  return clientMutationResponseSchema.parse(await clientImportRpc(client, 'update_client', {
    p_client_id: clientId, p_command: command, p_idempotency_key: idempotencyKey, p_origin: origin,
  }));
}

export async function listManagedClientSellers(client: SupabaseClient) {
  const sellers = await clientImportRpc(client, 'list_client_management_sellers');
  return clientSellerListResponseSchema.parse({ schemaVersion: 1, sellers });
}
