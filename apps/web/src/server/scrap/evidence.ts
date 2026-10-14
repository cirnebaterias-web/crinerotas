import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  attachmentConfirmationSchema, scrapAttachmentUploadIntentResultSchema,
  type AttachmentConfirmRequest, type ScrapAttachmentUploadIntentRequest,
} from '@cirne/contracts';
import { readEvidenceConfig } from '@cirne/config/server';
import { createEvidenceVerifierClient } from '../evidence-verifier';
import { RouteRequestError } from '../routes/http';
import { scrapResponse, scrapRpc } from './http';

const scrapEvidenceBucket = 'scrap-evidence';

const metadataSchema = z.object({
  storagePath: z.string().min(1), contentType: z.enum(['image/jpeg', 'image/webp']),
  byteSize: z.number().int().positive().max(2 * 1024 * 1024), checksum: z.string().regex(/^[a-f0-9]{64}$/u),
}).passthrough();
function unavailable() {
  return new RouteRequestError(503, 'DEPENDENCY_UNAVAILABLE', 'Comprovantes temporariamente indisponíveis.', true);
}
function requireScrapEvidenceEnabled() {
  if (!readEvidenceConfig(process.env).EVIDENCE_REMOTE_SYNC_ENABLED) throw unavailable();
}
export async function createScrapUploadIntent(client: SupabaseClient, deviceId: string,
  idempotencyKey: string, command: ScrapAttachmentUploadIntentRequest) {
  requireScrapEvidenceEnabled();
  const reserved = await scrapRpc(client, 'reserve_scrap_attachment', {
    p_device_id: deviceId, p_idempotency_key: idempotencyKey, p_command: command,
  }) as Record<string, unknown>;
  if (!reserved || typeof reserved.storagePath !== 'string') throw unavailable();
  if (reserved.status === 'verified') {
    return scrapResponse(scrapAttachmentUploadIntentResultSchema, {
      schemaVersion: 1, attachmentId: reserved.attachmentId, offlineId: reserved.offlineId,
      alreadyVerified: true, verifiedAt: reserved.verifiedAt,
    });
  }
  let signed;
  try {
    const response = await client.storage.from(scrapEvidenceBucket)
      .createSignedUploadUrl(reserved.storagePath);
    if (response.error) throw unavailable();
    signed = response.data;
  } catch { throw unavailable(); }
  return scrapResponse(scrapAttachmentUploadIntentResultSchema, {
    schemaVersion: 1, attachmentId: reserved.attachmentId, offlineId: reserved.offlineId,
    signedUrl: signed.signedUrl, token: signed.token,
    expiresInSeconds: 600, alreadyVerified: false,
  });
}
export async function confirmScrapAttachment(client: SupabaseClient, offlineId: string,
  deviceId: string, idempotencyKey: string, command: AttachmentConfirmRequest, sellerId: string) {
  requireScrapEvidenceEnabled();
  const metadata = scrapResponse(metadataSchema, await scrapRpc(client, 'get_scrap_attachment_for_confirmation', {
    p_device_id: deviceId, p_offline_id: offlineId,
  }));
  let response;
  try {
    response = await client.storage.from(scrapEvidenceBucket).download(metadata.storagePath);
  } catch { throw unavailable(); }
  if (response.error) {
    const status = Number((response.error as { statusCode?: unknown }).statusCode ??
      (response.error as { status?: unknown }).status);
    if (status !== 404) throw unavailable();
  }
  if (response.error || !response.data || response.data.size > 2 * 1024 * 1024) {
    throw new RouteRequestError(422, 'VALIDATION_FAILED', 'Comprovante inválido.', false);
  }
  let bytes;
  try { bytes = new Uint8Array(await response.data.arrayBuffer()); } catch { throw unavailable(); }
  const signatureMatches = metadata.contentType === 'image/jpeg'
    ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    : new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' && new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP';
  const checksum = createHash('sha256').update(bytes).digest('hex');
  if (bytes.byteLength !== metadata.byteSize || !signatureMatches || checksum !== command.checksum || checksum !== metadata.checksum) {
    throw new RouteRequestError(422, 'VALIDATION_FAILED', 'Comprovante inválido.', false);
  }
  let verifier: SupabaseClient;
  try { verifier = await createEvidenceVerifierClient(); } catch { throw unavailable(); }
  return scrapResponse(attachmentConfirmationSchema, await scrapRpc(verifier, 'verify_scrap_attachment', {
    p_seller_id: sellerId, p_device_id: deviceId, p_idempotency_key: idempotencyKey,
    p_offline_id: offlineId, p_checksum: checksum,
  }));
}
export async function listScrapEvidence(client: SupabaseClient, collectionId: string) {
  const rows = scrapResponse(z.array(z.object({
    attachmentId: z.uuid(), offlineId: z.uuid(), storagePath: z.string().min(1),
    status: z.enum(['reserved', 'verified']),
  }).passthrough()), await scrapRpc(client, 'list_scrap_evidence', { p_collection_id: collectionId }));
  const attachments = await Promise.all(rows.filter((row) => row.status === 'verified')
    .map(async ({ storagePath, ...metadata }) => {
      try {
        const { data, error } = await client.storage.from(scrapEvidenceBucket)
          .createSignedUrl(storagePath, 300);
        if (error || !data?.signedUrl) throw unavailable();
        return { ...metadata, signedUrl: data.signedUrl, expiresInSeconds: 300 };
      } catch { throw unavailable(); }
    }));
  return { schemaVersion: 1, attachments };
}
