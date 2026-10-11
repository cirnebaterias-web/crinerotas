import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalAttachment, OfflinePartition } from '@cirne/contracts';
import { FetchScrapEvidenceTransport, ScrapEvidenceSyncCoordinator } from './scrap-evidence-sync';

const partition: OfflinePartition = {
  userId: '11111111-1111-4111-8111-111111111111',
  deviceId: '22222222-2222-4222-8222-222222222222',
};
const visitOfflineId = '33333333-3333-4333-8333-333333333333';
const collectionOfflineId = '44444444-4444-4444-8444-444444444444';
const attachmentOfflineId = '55555555-5555-4555-8555-555555555555';
const at = '2026-10-06T12:00:00.000Z';

afterEach(() => vi.unstubAllGlobals());

function fixture(alreadyVerified = false) {
  const blob = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' });
  const attachment: LocalAttachment = {
    schemaVersion: 1, ...partition, offlineId: attachmentOfflineId, visitOfflineId,
    purpose: 'scrap_receipt', targetOfflineId: collectionOfflineId, fileName: 'termo.jpg',
    contentType: 'image/jpeg', byteSize: blob.size, width: 10, height: 10,
    checksum: 'a'.repeat(64), capturedAt: at, status: 'pending', blob,
  };
  const repository = {
    listPendingScrapAttachments: vi.fn().mockResolvedValue([attachment]),
    getDraft: vi.fn().mockResolvedValue({
      canonicalVisitId: '66666666-6666-4666-8666-666666666666',
      scrap: { availability: 'collected', persistenceState: 'synced',
        collection: { attachmentOfflineIds: [attachmentOfflineId] } },
    }),
    markVisitAttachmentVerified: vi.fn().mockResolvedValue({ ...attachment, status: 'verified' }),
    markVisitAttachmentActionRequired: vi.fn(),
  };
  const transport = {
    createUploadIntent: vi.fn().mockResolvedValue(alreadyVerified
      ? { schemaVersion: 1, attachmentId: '77777777-7777-4777-8777-777777777777',
        offlineId: attachmentOfflineId, alreadyVerified: true, verifiedAt: at }
      : { schemaVersion: 1, attachmentId: '77777777-7777-4777-8777-777777777777',
        offlineId: attachmentOfflineId, alreadyVerified: false,
        signedUrl: 'https://storage.test/upload', token: 'signed', expiresInSeconds: 600 }),
    upload: vi.fn().mockResolvedValue(undefined),
    confirm: vi.fn().mockResolvedValue({ attachmentId: '77777777-7777-4777-8777-777777777777', verifiedAt: at }),
  };
  return { attachment, repository, transport };
}

describe('scrap evidence sync', () => {
  it('uses the scrap route CSRF header for signed-term upload intent', async () => {
    const { attachment } = fixture();
    const request = vi.fn<typeof fetch>(async () => Response.json({
      schemaVersion: 1, attachmentId: '77777777-7777-4777-8777-777777777777',
      offlineId: attachmentOfflineId, alreadyVerified: false,
      signedUrl: 'https://storage.test/upload', token: 'signed', expiresInSeconds: 600,
    }));
    vi.stubGlobal('fetch', request);
    await new FetchScrapEvidenceTransport().createUploadIntent(partition.deviceId, attachment);
    expect((request.mock.calls[0]?.[1]?.headers as Record<string, string>)['X-CSRF-Token'])
      .toBe('cirne-route-v1');
  });

  it('uploads and verifies the signed physical term before marking it complete locally', async () => {
    const { repository, transport } = fixture();
    const result = await new ScrapEvidenceSyncCoordinator(repository as never, transport as never).synchronize(partition);
    expect(result).toMatchObject({ attempted: 1, confirmed: 1, actionRequired: 0 });
    expect(transport.upload).toHaveBeenCalledOnce();
    expect(transport.confirm).toHaveBeenCalledOnce();
    expect(repository.markVisitAttachmentVerified).toHaveBeenCalledWith(partition, attachmentOfflineId,
      '77777777-7777-4777-8777-777777777777', at);
  });

  it('accepts an already-verified replay without reopening the upload', async () => {
    const { repository, transport } = fixture(true);
    const result = await new ScrapEvidenceSyncCoordinator(repository as never, transport as never).synchronize(partition);
    expect(result.confirmed).toBe(1);
    expect(transport.upload).not.toHaveBeenCalled();
    expect(transport.confirm).not.toHaveBeenCalled();
  });
});
