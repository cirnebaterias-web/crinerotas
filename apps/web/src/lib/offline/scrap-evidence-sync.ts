import {
  apiErrorResponseSchema,
  attachmentConfirmationSchema,
  scrapAttachmentUploadIntentResultSchema,
  scrapAttachmentConfirmPath,
  scrapAttachmentUploadIntentsPath,
  type LocalAttachment,
  type OfflinePartition,
} from '@cirne/contracts';
import type { OfflineRepository } from './repository';
import { EvidenceSyncError, FetchEvidenceSyncTransport, type EvidenceSyncSummary } from './evidence-sync';

const scrapCsrfToken = 'cirne-route-v1';

async function parseResponse(response: Response): Promise<unknown> {
  let body: unknown;
  try { body = await response.json(); } catch { body = null; }
  if (!response.ok) {
    const parsed = apiErrorResponseSchema.safeParse(body);
    const code = parsed.success ? parsed.data.error.code : '';
    throw new EvidenceSyncError(response.status,
      response.status === 503 && code === 'DEPENDENCY_UNAVAILABLE',
      response.status >= 400 && response.status < 500 && ![401, 409].includes(response.status));
  }
  return body;
}

function headers(deviceId: string, idempotencyKey: string) {
  return {
    'Content-Type': 'application/json',
    'X-CSRF-Token': scrapCsrfToken,
    'X-Device-Id': deviceId,
    'Idempotency-Key': idempotencyKey,
  };
}

export class FetchScrapEvidenceTransport {
  private readonly uploadTransport = new FetchEvidenceSyncTransport();

  private async mutate(path: string, deviceId: string, key: string, body: unknown) {
    let response: Response;
    try {
      response = await fetch(path, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: headers(deviceId, key), body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
      });
    } catch { throw new EvidenceSyncError(0, false, false); }
    return parseResponse(response);
  }

  async createUploadIntent(deviceId: string, attachment: LocalAttachment) {
    if (!attachment.targetOfflineId) throw new EvidenceSyncError(422, false, true);
    return scrapAttachmentUploadIntentResultSchema.parse(await this.mutate(
      scrapAttachmentUploadIntentsPath, deviceId, attachment.offlineId,
      {
        schemaVersion: 1, offlineId: attachment.offlineId,
        collectionOfflineId: attachment.targetOfflineId,
        contentType: attachment.contentType, byteSize: attachment.byteSize,
        checksum: attachment.checksum, capturedAt: attachment.capturedAt,
      },
    ));
  }

  upload(signedUrl: string, token: string, attachment: LocalAttachment) {
    return this.uploadTransport.upload(signedUrl, token, attachment);
  }

  async confirm(deviceId: string, attachment: LocalAttachment) {
    return attachmentConfirmationSchema.parse(await this.mutate(
      scrapAttachmentConfirmPath(attachment.offlineId), deviceId, attachment.offlineId,
      { schemaVersion: 1, checksum: attachment.checksum },
    ));
  }
}

export class ScrapEvidenceSyncCoordinator {
  constructor(
    private readonly repository: Pick<OfflineRepository,
      'listPendingScrapAttachments' | 'getDraft' | 'markVisitAttachmentVerified' |
      'markVisitAttachmentActionRequired'>,
    private readonly transport: FetchScrapEvidenceTransport,
  ) {}

  async synchronize(partition: OfflinePartition): Promise<EvidenceSyncSummary> {
    const summary: EvidenceSyncSummary = {
      attempted: 0, confirmed: 0, recoverable: 0, actionRequired: 0,
      disabled: false, authenticationRequired: false,
    };
    const attachments = await this.repository.listPendingScrapAttachments(partition);
    for (const attachment of attachments) {
      const draft = await this.repository.getDraft(partition, attachment.visitOfflineId);
      if (!draft?.canonicalVisitId || draft.scrap?.availability !== 'collected' ||
          draft.scrap.persistenceState !== 'synced' ||
          !draft.scrap.collection?.attachmentOfflineIds.includes(attachment.offlineId)) continue;
      summary.attempted += 1;
      try {
        const intent = await this.transport.createUploadIntent(partition.deviceId, attachment);
        if (!intent.alreadyVerified) {
          await this.transport.upload(intent.signedUrl, intent.token, attachment);
          const confirmation = await this.transport.confirm(partition.deviceId, attachment);
          await this.repository.markVisitAttachmentVerified(
            partition, attachment.offlineId, confirmation.attachmentId, confirmation.verifiedAt,
          );
        } else {
          await this.repository.markVisitAttachmentVerified(
            partition, attachment.offlineId, intent.attachmentId,
            intent.verifiedAt ?? attachment.capturedAt,
          );
        }
        summary.confirmed += 1;
      } catch (error) {
        const failure = error instanceof EvidenceSyncError ? error : new EvidenceSyncError(0, false, false);
        if (failure.disabled) { summary.disabled = true; summary.attempted -= 1; break; }
        if (failure.status === 401) summary.authenticationRequired = true;
        if (failure.actionRequired) {
          await this.repository.markVisitAttachmentActionRequired(partition, attachment.offlineId);
          summary.actionRequired += 1;
        } else summary.recoverable += 1;
      }
    }
    return summary;
  }
}
