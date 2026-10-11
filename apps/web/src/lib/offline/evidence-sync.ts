import {
  apiErrorResponseSchema,
  attachmentConfirmPath,
  attachmentConfirmationSchema,
  attachmentUploadIntentResultSchema,
  attachmentUploadIntentsPath,
  visitCheckinEvidencePath,
  visitCompletePath,
  visitCompletionResultSchema,
  visitCsrfToken,
  visitEvidenceResultSchema,
  type AttachmentUploadIntentRequest,
  type CompleteVisitRequest,
  type LocalAttachment,
  type LocalVisitEvidence,
  type OfflinePartition,
  type SaveVisitCheckinEvidenceRequest,
} from '@cirne/contracts';
import type { OfflineRepository } from './repository';

export class EvidenceSyncError extends Error {
  constructor(
    public readonly status: number,
    public readonly disabled: boolean,
    public readonly actionRequired: boolean,
  ) { super(`evidence_sync_${status}`); }
}

export interface EvidenceSyncTransport {
  createUploadIntent(deviceId: string, input: AttachmentUploadIntentRequest): Promise<{
    attachmentId: string;
    signedUrl: string;
    token: string;
    alreadyVerified: boolean;
    verifiedAt?: string;
  }>;
  upload(signedUrl: string, token: string, attachment: LocalAttachment): Promise<void>;
  confirm(deviceId: string, attachment: LocalAttachment): Promise<{ attachmentId: string; verifiedAt: string }>;
  saveCheckin(deviceId: string, input: SaveVisitCheckinEvidenceRequest): Promise<{ serverSavedAt: string }>;
  complete(deviceId: string, input: CompleteVisitRequest): Promise<{ serverCompletedAt: string }>;
}

async function readResponse(response: Response) {
  let body: unknown;
  try { body = await response.json(); } catch { body = null; }
  if (!response.ok) {
    const parsed = apiErrorResponseSchema.safeParse(body);
    const code = parsed.success ? parsed.data.error.code : '';
    throw new EvidenceSyncError(
      response.status,
      response.status === 503 && code === 'DEPENDENCY_UNAVAILABLE',
      response.status >= 400 && response.status < 500 && ![401, 409].includes(response.status),
    );
  }
  return body;
}

function mutationHeaders(deviceId: string, idempotencyKey: string) {
  return {
    'Content-Type': 'application/json',
    'X-CSRF-Token': visitCsrfToken,
    'X-Device-Id': deviceId,
    'Idempotency-Key': idempotencyKey,
  };
}

export class FetchEvidenceSyncTransport implements EvidenceSyncTransport {
  private async jsonMutation(path: string, method: 'POST' | 'PUT', deviceId: string, key: string, body: unknown) {
    let response: Response;
    try {
      response = await fetch(path, {
        method, credentials: 'same-origin', cache: 'no-store',
        headers: mutationHeaders(deviceId, key), body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch { throw new EvidenceSyncError(0, false, false); }
    return readResponse(response);
  }

  async createUploadIntent(deviceId: string, input: AttachmentUploadIntentRequest) {
    const parsed = attachmentUploadIntentResultSchema.parse(await this.jsonMutation(
      attachmentUploadIntentsPath, 'POST', deviceId, input.offlineId, input,
    ));
    return parsed;
  }

  async upload(signedUrl: string, token: string, attachment: LocalAttachment) {
    const url = new URL(signedUrl);
    if (!url.searchParams.has('token')) url.searchParams.set('token', token);
    const body = new FormData();
    body.append('cacheControl', '3600');
    body.append('', attachment.blob);
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'PUT', credentials: 'omit', headers: { 'x-upsert': 'false' }, body,
        signal: AbortSignal.timeout(60_000),
      });
    } catch { throw new EvidenceSyncError(0, false, false); }
    if (!response.ok && response.status !== 409) {
      throw new EvidenceSyncError(response.status, false, response.status >= 400 && response.status < 500);
    }
  }

  async confirm(deviceId: string, attachment: LocalAttachment) {
    const parsed = attachmentConfirmationSchema.parse(await this.jsonMutation(
      attachmentConfirmPath(attachment.offlineId), 'POST', deviceId, attachment.offlineId,
      { schemaVersion: 1, checksum: attachment.checksum },
    ));
    return { attachmentId: parsed.attachmentId, verifiedAt: parsed.verifiedAt };
  }

  async saveCheckin(deviceId: string, input: SaveVisitCheckinEvidenceRequest) {
    return visitEvidenceResultSchema.parse(await this.jsonMutation(
      visitCheckinEvidencePath(input.offlineId), 'PUT', deviceId, input.evidence.offlineId, input,
    ));
  }

  async complete(deviceId: string, input: CompleteVisitRequest) {
    return visitCompletionResultSchema.parse(await this.jsonMutation(
      visitCompletePath(input.offlineId), 'POST', deviceId, input.evidence.offlineId, input,
    ));
  }
}

export interface EvidenceSyncSummary {
  attempted: number;
  confirmed: number;
  recoverable: number;
  actionRequired: number;
  disabled: boolean;
  authenticationRequired: boolean;
}

function evidencePayload(evidence: LocalVisitEvidence) {
  return {
    offlineId: evidence.offlineId,
    ...(evidence.attachmentOfflineId ? { attachmentOfflineId: evidence.attachmentOfflineId } : {}),
    capturedAt: evidence.capturedAt,
    location: {
      ...(evidence.latitude ? { latitude: evidence.latitude } : {}),
      ...(evidence.longitude ? { longitude: evidence.longitude } : {}),
      ...(evidence.accuracyM ? { accuracyM: evidence.accuracyM } : {}),
      ...(evidence.distanceM ? { distanceM: evidence.distanceM } : {}),
    },
    issues: evidence.issues,
    ...(evidence.justification ? { justification: evidence.justification } : {}),
  };
}

export class EvidenceSyncCoordinator {
  constructor(
    private readonly repository: Pick<OfflineRepository,
      'listPendingVisitEvidence' | 'listPendingCommercialActionAttachments' | 'getDraft' | 'getVisitAttachment' |
      'markVisitAttachmentVerified' | 'markVisitAttachmentActionRequired' |
      'markVisitEvidenceSynced' | 'markVisitEvidenceActionRequired'>,
    private readonly transport: EvidenceSyncTransport,
  ) {}

  async synchronize(partition: OfflinePartition): Promise<EvidenceSyncSummary> {
    const pending = await this.repository.listPendingVisitEvidence(partition);
    const summary: EvidenceSyncSummary = {
      attempted: 0, confirmed: 0, recoverable: 0, actionRequired: 0, disabled: false,
      authenticationRequired: false,
    };
    for (const evidence of pending) {
      const draft = await this.repository.getDraft(partition, evidence.visitOfflineId);
      if (!draft?.canonicalVisitId) continue;
      if (evidence.kind === 'checkout' && draft.scrap?.availability === 'collected') {
        let verified = true;
        for (const offlineId of draft.scrap.collection!.attachmentOfflineIds) {
          const photo = await this.repository.getVisitAttachment(partition, offlineId);
          if (photo?.status !== 'verified' && photo?.status !== 'synced') verified = false;
        }
        if (!verified) continue;
      }
      summary.attempted += 1;
      try {
        if (evidence.attachmentOfflineId) {
          let attachment = await this.repository.getVisitAttachment(partition, evidence.attachmentOfflineId);
          if (!attachment) throw new EvidenceSyncError(422, false, true);
          if (attachment.status === 'pending') {
            const intent = await this.transport.createUploadIntent(partition.deviceId, {
              schemaVersion: 1,
              offlineId: attachment.offlineId,
              visitOfflineId: evidence.visitOfflineId,
              purpose: evidence.kind === 'checkin' ? 'visit_checkin' : 'visit_checkout',
              contentType: attachment.contentType,
              byteSize: attachment.byteSize,
              checksum: attachment.checksum,
              capturedAt: attachment.capturedAt,
              expiresAt: evidence.expiresAt,
            });
            if (!intent.alreadyVerified) {
              await this.transport.upload(intent.signedUrl, intent.token, attachment);
              const confirmation = await this.transport.confirm(partition.deviceId, attachment);
              attachment = await this.repository.markVisitAttachmentVerified(
                partition, attachment.offlineId, confirmation.attachmentId, confirmation.verifiedAt,
              );
            } else {
              attachment = await this.repository.markVisitAttachmentVerified(
                partition, attachment.offlineId, intent.attachmentId, intent.verifiedAt ?? evidence.capturedAt,
              );
            }
          }
        }
        const payload = { schemaVersion: 1 as const, offlineId: evidence.visitOfflineId, evidence: evidencePayload(evidence) };
        const serverSyncedAt = evidence.kind === 'checkin'
          ? (await this.transport.saveCheckin(partition.deviceId, payload)).serverSavedAt
          : (await this.transport.complete(partition.deviceId, {
            ...payload, deviceCompletedAt: draft.deviceCompletedAt ?? evidence.capturedAt,
          })).serverCompletedAt;
        await this.repository.markVisitEvidenceSynced(
          partition, evidence.offlineId, serverSyncedAt,
        );
        summary.confirmed += 1;
      } catch (error) {
        const failure = error instanceof EvidenceSyncError ? error : new EvidenceSyncError(0, false, false);
        if (failure.disabled) {
          summary.disabled = true;
          summary.attempted -= 1;
          break;
        }
        if (failure.status === 401) summary.authenticationRequired = true;
        if (failure.actionRequired) {
          await this.repository.markVisitEvidenceActionRequired(partition, evidence.offlineId);
          summary.actionRequired += 1;
        } else {
          summary.recoverable += 1;
        }
      }
    }
    if (summary.disabled || summary.authenticationRequired) return summary;
    const actionAttachments = await this.repository.listPendingCommercialActionAttachments(partition);
    for (const attachment of actionAttachments) {
      const draft = await this.repository.getDraft(partition, attachment.visitOfflineId);
      if (!draft?.canonicalVisitId) continue;
      summary.attempted += 1;
      try {
        const expiresAt = new Date(new Date(attachment.capturedAt).getTime() + 180 * 24 * 60 * 60 * 1000).toISOString();
        const intent = await this.transport.createUploadIntent(partition.deviceId, {
          schemaVersion: 1,
          offlineId: attachment.offlineId,
          visitOfflineId: attachment.visitOfflineId,
          purpose: 'commercial_action_evidence',
          contentType: attachment.contentType,
          byteSize: attachment.byteSize,
          checksum: attachment.checksum,
          capturedAt: attachment.capturedAt,
          expiresAt,
        });
        if (!intent.alreadyVerified) {
          await this.transport.upload(intent.signedUrl, intent.token, attachment);
          const confirmation = await this.transport.confirm(partition.deviceId, attachment);
          await this.repository.markVisitAttachmentVerified(
            partition, attachment.offlineId, confirmation.attachmentId, confirmation.verifiedAt,
          );
        } else {
          await this.repository.markVisitAttachmentVerified(
            partition, attachment.offlineId, intent.attachmentId, intent.verifiedAt ?? attachment.capturedAt,
          );
        }
        summary.confirmed += 1;
      } catch (error) {
        const failure = error instanceof EvidenceSyncError ? error : new EvidenceSyncError(0, false, false);
        if (failure.disabled) {
          summary.disabled = true;
          summary.attempted -= 1;
          break;
        }
        if (failure.status === 401) summary.authenticationRequired = true;
        if (failure.actionRequired) {
          await this.repository.markVisitAttachmentActionRequired(partition, attachment.offlineId);
          summary.actionRequired += 1;
        } else {
          summary.recoverable += 1;
        }
      }
    }
    return summary;
  }
}
