import type { MeResponse, ReviseScrapCollectionRequest, ReviseScrapReceiptRequest } from '@cirne/contracts';
import { scrapCollectionSchema, scrapReceiptSchema } from '@cirne/contracts';
import type { SupabaseClient } from '@supabase/supabase-js';
import { RouteRequestError } from '../routes/http';
import { requireScrapAccess, scrapResponse, scrapRpc } from './http';

export function requireScrapRevisionAccess(identity: MeResponse) {
  requireScrapAccess(identity, 'scrap.manage_operations');
  if (!identity.roles.some((role) => role === 'manager' || role === 'administrator')) {
    throw new RouteRequestError(403, 'FORBIDDEN', 'Correção exige perfil de Gestão ou Administração.', false);
  }
}
export async function reviseScrapCollection(client: SupabaseClient, collectionId: string,
  idempotencyKey: string, command: ReviseScrapCollectionRequest) {
  return scrapResponse(scrapCollectionSchema, await scrapRpc(client, 'revise_scrap_collection', {
    p_collection_id: collectionId, p_idempotency_key: idempotencyKey, p_command: command,
  }));
}
export async function reviseScrapReceipt(client: SupabaseClient, collectionId: string,
  idempotencyKey: string, command: ReviseScrapReceiptRequest) {
  return scrapResponse(scrapReceiptSchema, await scrapRpc(client, 'revise_scrap_receipt', {
    p_collection_id: collectionId, p_idempotency_key: idempotencyKey, p_command: command,
  }));
}
