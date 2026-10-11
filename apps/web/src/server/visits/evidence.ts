import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  attachmentConfirmationSchema,
  attachmentUploadIntentResultSchema,
  visitErrorCodeSchema,
  visitEvidenceResultSchema,
  visitCompletionResultSchema,
  type AttachmentConfirmRequest,
  type AttachmentUploadIntentRequest,
  type CompleteVisitRequest,
  type SaveVisitCheckinEvidenceRequest,
} from '@cirne/contracts';
import { readEvidenceConfig } from '@cirne/config/server';
import { createEvidenceVerifierClient } from '../evidence-verifier';
import { publicVisitMessage, VisitServiceFailure } from './service';

const maxEvidenceBytes = 2 * 1024 * 1024;

function unavailable() {
  return new VisitServiceFailure('DEPENDENCY_UNAVAILABLE', publicVisitMessage('DEPENDENCY_UNAVAILABLE'), true);
}

function mapRpcFailure(error: unknown) {
  if (!error || typeof error !== 'object') return unavailable();
  const candidate = error as { code?: unknown; message?: unknown };
  if (candidate.code !== 'P0001') return unavailable();
  if (candidate.message === 'ATTACHMENT_NOT_VERIFIED') {
    return new VisitServiceFailure('VERSION_CONFLICT',
      'A foto do termo de sucata ainda não foi confirmada. Sincronize antes de concluir a visita.', false);
  }
  const parsed = visitErrorCodeSchema.safeParse(candidate.message);
  if (!parsed.success) return unavailable();
  const code = parsed.data;
  return new VisitServiceFailure(
    code,
    publicVisitMessage(code),
    ['AUTH_REQUIRED', 'EVENT_OUT_OF_ORDER', 'DEPENDENCY_UNAVAILABLE', 'INTERNAL_ERROR'].includes(code),
  );
}

export function requireRemoteEvidenceEnabled() {
  if (!readEvidenceConfig(process.env).EVIDENCE_REMOTE_SYNC_ENABLED) throw unavailable();
}

function signatureMatches(bytes: Uint8Array, contentType: string) {
  if (contentType === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return contentType === 'image/webp' && new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' &&
    new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP';
}

async function rpc(client: SupabaseClient, name: string, args: Record<string, unknown>) {
  try {
    const response = await client.schema('api').rpc(name, args).abortSignal(AbortSignal.timeout(30_000));
    if (response.error) throw mapRpcFailure(response.error);
    return response.data;
  } catch (error) {
    if (error instanceof VisitServiceFailure) throw error;
    throw unavailable();
  }
}

export async function createEvidenceUploadIntent(
  client: SupabaseClient,
  deviceId: string,
  idempotencyKey: string,
  command: AttachmentUploadIntentRequest,
) {
  requireRemoteEvidenceEnabled();
  const reserved = await rpc(client, 'reserve_visit_attachment', {
    p_device_id: deviceId,
    p_idempotency_key: idempotencyKey,
    p_command: command,
  }) as Record<string, unknown>;
  const storagePath = typeof reserved.storagePath === 'string' ? reserved.storagePath : '';
  let signed: { signedUrl?: string; token?: string } | null = null;
  try {
    const bucket = readEvidenceConfig(process.env).EVIDENCE_STORAGE_BUCKET;
    const response = await client.storage.from(bucket).createSignedUploadUrl(storagePath);
    if (response.error) throw response.error;
    signed = response.data;
  } catch {
    throw unavailable();
  }
  const parsed = attachmentUploadIntentResultSchema.safeParse({
    schemaVersion: 1,
    attachmentId: reserved.attachmentId,
    offlineId: reserved.offlineId,
    storagePath,
    signedUrl: signed?.signedUrl,
    token: signed?.token,
    expiresInSeconds: 600,
    alreadyVerified: reserved.status === 'verified',
    ...(typeof reserved.verifiedAt === 'string' ? { verifiedAt: reserved.verifiedAt } : {}),
  });
  if (!parsed.success) throw unavailable();
  return parsed.data;
}

export async function confirmEvidenceAttachment(
  client: SupabaseClient,
  offlineId: string,
  deviceId: string,
  idempotencyKey: string,
  command: AttachmentConfirmRequest,
  sellerId: string,
) {
  requireRemoteEvidenceEnabled();
  const metadata = await rpc(client, 'get_visit_attachment_for_confirmation', {
    p_device_id: deviceId,
    p_offline_id: offlineId,
  }) as Record<string, unknown>;
  const bucket = readEvidenceConfig(process.env).EVIDENCE_STORAGE_BUCKET;
  let response: Awaited<ReturnType<ReturnType<typeof client.storage.from>['download']>>;
  try {
    response = await client.storage.from(bucket).download(String(metadata.storagePath));
  } catch {
    throw unavailable();
  }
  if (response.error) {
    const status = Number((response.error as { status?: unknown; statusCode?: unknown }).statusCode ??
      (response.error as { status?: unknown }).status);
    if (status !== 404) throw unavailable();
  }
  if (response.error || !response.data || response.data.size > maxEvidenceBytes) {
    throw new VisitServiceFailure('VALIDATION_FAILED', publicVisitMessage('VALIDATION_FAILED'), false);
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await response.data.arrayBuffer());
  } catch {
    throw unavailable();
  }
  const contentType = String(metadata.contentType);
  const checksum = createHash('sha256').update(bytes).digest('hex');
  if (bytes.byteLength !== metadata.byteSize || !signatureMatches(bytes, contentType) ||
      checksum !== command.checksum || checksum !== metadata.checksum) {
    throw new VisitServiceFailure('VALIDATION_FAILED', publicVisitMessage('VALIDATION_FAILED'), false);
  }
  let verifier: SupabaseClient;
  try { verifier = await createEvidenceVerifierClient(); } catch { throw unavailable(); }
  const result = await rpc(verifier, 'verify_visit_attachment', {
    p_seller_id: sellerId,
    p_device_id: deviceId,
    p_idempotency_key: idempotencyKey,
    p_offline_id: offlineId,
    p_checksum: checksum,
  });
  const parsed = attachmentConfirmationSchema.safeParse(result);
  if (!parsed.success) throw unavailable();
  return parsed.data;
}

export async function completeVisitWithEvidence(
  client: SupabaseClient,
  deviceId: string,
  idempotencyKey: string,
  command: CompleteVisitRequest,
) {
  requireRemoteEvidenceEnabled();
  const result = await rpc(client, 'complete_visit', {
    p_device_id: deviceId,
    p_idempotency_key: idempotencyKey,
    p_command: command,
  });
  const parsed = visitCompletionResultSchema.safeParse(result);
  if (!parsed.success) throw unavailable();
  return parsed.data;
}

export async function saveVisitCheckinEvidence(
  client: SupabaseClient,
  deviceId: string,
  idempotencyKey: string,
  command: SaveVisitCheckinEvidenceRequest,
) {
  requireRemoteEvidenceEnabled();
  const result = await rpc(client, 'save_visit_checkin_evidence', {
    p_device_id: deviceId,
    p_idempotency_key: idempotencyKey,
    p_command: command,
  });
  const parsed = visitEvidenceResultSchema.safeParse(result);
  if (!parsed.success) throw unavailable();
  return parsed.data;
}
