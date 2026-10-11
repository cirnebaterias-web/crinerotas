import { describe, expect, it, vi } from 'vitest';
import type { LocalAttachment, LocalVisitEvidence, OfflinePartition } from '@cirne/contracts';
import {
  EvidenceSyncCoordinator,
  EvidenceSyncError,
  type EvidenceSyncTransport,
} from './evidence-sync';

const partition: OfflinePartition = {
  userId: '11111111-1111-4111-8111-111111111111',
  deviceId: '22222222-2222-4222-8222-222222222222',
};
const visitOfflineId = '33333333-3333-4333-8333-333333333333';
const evidenceOfflineId = '44444444-4444-4444-8444-444444444444';
const attachmentOfflineId = '55555555-5555-4555-8555-555555555555';
const remoteAttachmentId = '66666666-6666-4666-8666-666666666666';
const capturedAt = '2026-10-05T12:00:00.000Z';
const expiresAt = '2027-04-03T12:00:00.000Z';

function evidence(kind: 'checkin' | 'checkout' = 'checkin'): LocalVisitEvidence {
  return {
    schemaVersion: 1, ...partition, offlineId: evidenceOfflineId, visitOfflineId, kind,
    attachmentOfflineId, capturedAt, latitude: '-7.1195', longitude: '-34.8450',
    accuracyM: '12', distanceM: '18', radiusM: 100, desiredAccuracyM: 50,
    issues: [], status: 'pending', expiresAt,
  };
}

function attachment(status: LocalAttachment['status'] = 'pending'): LocalAttachment {
  const blob = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' });
  return {
    schemaVersion: 1, ...partition, offlineId: attachmentOfflineId, visitOfflineId,
    purpose: 'visit_checkin', fileName: 'checkin.jpg', contentType: 'image/jpeg',
    byteSize: blob.size, width: 10, height: 10, checksum: 'a'.repeat(64), capturedAt,
    status, blob,
  };
}

function repository(item: LocalVisitEvidence, photo: LocalAttachment | undefined) {
  return {
    listPendingVisitEvidence: vi.fn().mockResolvedValue([item]),
    listPendingCommercialActionAttachments: vi.fn().mockResolvedValue([]),
    getDraft: vi.fn().mockResolvedValue({ canonicalVisitId: '77777777-7777-4777-8777-777777777777', deviceCompletedAt: capturedAt }),
    getVisitAttachment: vi.fn().mockResolvedValue(photo),
    markVisitAttachmentVerified: vi.fn().mockImplementation(async () => attachment('verified')),
    markVisitAttachmentActionRequired: vi.fn().mockResolvedValue(undefined),
    markVisitEvidenceSynced: vi.fn().mockResolvedValue({ ...item, status: 'synced' }),
    markVisitEvidenceActionRequired: vi.fn().mockResolvedValue({ ...item, status: 'action_required' }),
  };
}

function transport(): EvidenceSyncTransport {
  return {
    createUploadIntent: vi.fn().mockResolvedValue({
      attachmentId: remoteAttachmentId, signedUrl: 'https://storage.test/upload?token=signed',
      token: 'signed', alreadyVerified: false,
    }),
    upload: vi.fn().mockResolvedValue(undefined),
    confirm: vi.fn().mockResolvedValue({ attachmentId: remoteAttachmentId, verifiedAt: capturedAt }),
    saveCheckin: vi.fn().mockResolvedValue({ serverSavedAt: capturedAt }),
    complete: vi.fn().mockResolvedValue({ serverCompletedAt: capturedAt }),
  };
}

describe('EvidenceSyncCoordinator', () => {
  it('waits for the scrap term photo before sending visit checkout', async () => {
    const item = evidence('checkout');
    const repo = repository(item, attachment());
    repo.getDraft.mockResolvedValue({
      canonicalVisitId: '77777777-7777-4777-8777-777777777777', deviceCompletedAt: capturedAt,
      scrap: { availability: 'collected', collection: { attachmentOfflineIds: [attachmentOfflineId] } },
    });
    const remote = transport();
    const result = await new EvidenceSyncCoordinator(repo as never, remote).synchronize(partition);
    expect(result.attempted).toBe(0);
    expect(remote.complete).not.toHaveBeenCalled();
  });

  it('uploads, verifies and records check-in before marking local evidence synced', async () => {
    const item = evidence();
    const repo = repository(item, attachment());
    const remote = transport();
    const result = await new EvidenceSyncCoordinator(repo as never, remote).synchronize(partition);

    expect(result).toMatchObject({ attempted: 1, confirmed: 1, recoverable: 0, disabled: false });
    expect(remote.upload).toHaveBeenCalledOnce();
    expect(remote.confirm).toHaveBeenCalledOnce();
    expect(remote.saveCheckin).toHaveBeenCalledWith(partition.deviceId, expect.objectContaining({
      offlineId: visitOfflineId,
      evidence: expect.objectContaining({ offlineId: evidenceOfflineId, attachmentOfflineId }),
    }));
    expect(repo.markVisitEvidenceSynced).toHaveBeenCalledWith(partition, evidenceOfflineId, capturedAt);
  });

  it('resumes an already verified upload without sending the bytes twice', async () => {
    const item = evidence();
    const repo = repository(item, attachment());
    const remote = transport();
    vi.mocked(remote.createUploadIntent).mockResolvedValueOnce({
      attachmentId: remoteAttachmentId, signedUrl: 'https://storage.test/upload?token=signed',
      token: 'signed', alreadyVerified: true,
    });
    await new EvidenceSyncCoordinator(repo as never, remote).synchronize(partition);

    expect(remote.upload).not.toHaveBeenCalled();
    expect(remote.confirm).not.toHaveBeenCalled();
    expect(repo.markVisitAttachmentVerified).toHaveBeenCalledOnce();
    expect(remote.saveCheckin).toHaveBeenCalledOnce();
  });

  it('keeps local evidence pending when the guarded remote channel is disabled', async () => {
    const item = evidence('checkout');
    const repo = repository(item, attachment());
    const remote = transport();
    vi.mocked(remote.createUploadIntent).mockRejectedValueOnce(new EvidenceSyncError(503, true, false));
    const result = await new EvidenceSyncCoordinator(repo as never, remote).synchronize(partition);

    expect(result).toMatchObject({ attempted: 0, confirmed: 0, disabled: true });
    expect(repo.markVisitEvidenceSynced).not.toHaveBeenCalled();
    expect(repo.markVisitEvidenceActionRequired).not.toHaveBeenCalled();
  });

  it('uploads and verifies a commercial-action photo after the visit exists remotely', async () => {
    const item = evidence();
    const commercialPhoto: LocalAttachment = {
      ...attachment(), purpose: 'commercial_action_evidence',
      targetOfflineId: '88888888-8888-4888-8888-888888888888',
    };
    const repo = repository(item, commercialPhoto);
    repo.listPendingVisitEvidence.mockResolvedValueOnce([]);
    repo.listPendingCommercialActionAttachments.mockResolvedValueOnce([commercialPhoto]);
    const remote = transport();

    const result = await new EvidenceSyncCoordinator(repo as never, remote).synchronize(partition);

    expect(result).toMatchObject({ attempted: 1, confirmed: 1, recoverable: 0, disabled: false });
    expect(remote.createUploadIntent).toHaveBeenCalledWith(partition.deviceId, expect.objectContaining({
      offlineId: attachmentOfflineId,
      purpose: 'commercial_action_evidence',
    }));
    expect(remote.upload).toHaveBeenCalledWith(expect.any(String), 'signed', commercialPhoto);
    expect(repo.markVisitAttachmentVerified).toHaveBeenCalledWith(
      partition, attachmentOfflineId, remoteAttachmentId, capturedAt,
    );
  });
});
