import { afterEach, describe, expect, it, vi } from 'vitest';
import { confirmScrapAttachment, createScrapUploadIntent, listScrapEvidence } from './evidence';

afterEach(() => vi.unstubAllEnvs());
function mockClient(data: unknown, error: unknown = null) {
  const abortSignal = vi.fn().mockResolvedValue({ data, error });
  const createSignedUrl = vi.fn().mockResolvedValue({ data: { signedUrl: 'https://storage.test/private' }, error: null });
  const createSignedUploadUrl = vi.fn().mockResolvedValue({ data: {
    signedUrl: 'https://storage.test/upload', token: 'signed',
  }, error: null });
  const download = vi.fn();
  return {
    client: { schema: vi.fn(() => ({ rpc: vi.fn(() => ({ abortSignal })) })),
      storage: { from: vi.fn(() => ({ createSignedUrl, createSignedUploadUrl, download })) } },
    createSignedUrl, createSignedUploadUrl, download,
  };
}
describe('private scrap evidence', () => {
  it('uses the five-year scrap bucket rather than short-lived visit evidence storage', async () => {
    vi.stubEnv('EVIDENCE_REMOTE_SYNC_ENABLED', 'true');
    const { client, createSignedUploadUrl } = mockClient({
      attachmentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      offlineId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', storagePath: 'private/term.jpg', status: 'reserved',
    });
    const result = await createScrapUploadIntent(client as never, 'device', 'key', {} as never);
    expect(result.alreadyVerified).toBe(false);
    expect(client.storage.from).toHaveBeenCalledWith('scrap-evidence');
    expect(createSignedUploadUrl).toHaveBeenCalledWith('private/term.jpg');
  });

  it('replays verified uploads without granting a new upload token', async () => {
    vi.stubEnv('EVIDENCE_REMOTE_SYNC_ENABLED', 'true');
    const { client } = mockClient({ attachmentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      offlineId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', storagePath: 'private/term.jpg',
      status: 'verified', verifiedAt: '2026-10-06T12:00:00Z' });
    const result = await createScrapUploadIntent(client as never, 'device', 'key', {} as never);
    expect(result.alreadyVerified).toBe(true);
    expect(result).not.toHaveProperty('signedUrl');
    expect(result).not.toHaveProperty('storagePath');
    expect(client.storage.from).not.toHaveBeenCalled();
  });
  it('does not sign any URL when collection access is denied', async () => {
    const { client, createSignedUrl } = mockClient(null, { code: 'P0001', message: 'FORBIDDEN' });
    await expect(listScrapEvidence(client as never, 'collection-id')).rejects.toMatchObject({ status: 403 });
    expect(createSignedUrl).not.toHaveBeenCalled();
  });
  it('signs only authorized paths with short expiry and hides the private path', async () => {
    const { client, createSignedUrl } = mockClient([{
      attachmentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', offlineId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      storagePath: 'private/term.jpg', status: 'verified',
    }]);
    const result = await listScrapEvidence(client as never, 'collection-id');
    expect(createSignedUrl).toHaveBeenCalledWith('private/term.jpg', 300);
    expect(result.attachments[0]).not.toHaveProperty('storagePath');
    expect(result.attachments[0]).toHaveProperty('expiresInSeconds', 300);
  });
  it('never signs a reserved term, even if a stale RPC includes it', async () => {
    const { client, createSignedUrl } = mockClient([{
      attachmentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', offlineId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      storagePath: 'private/pending.jpg', status: 'reserved',
    }, {
      attachmentId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', offlineId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      storagePath: 'private/verified.jpg', status: 'verified',
    }]);
    const result = await listScrapEvidence(client as never, 'collection-id');
    expect(createSignedUrl).toHaveBeenCalledTimes(1);
    expect(createSignedUrl).toHaveBeenCalledWith('private/verified.jpg', 300);
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]).not.toHaveProperty('storagePath');
  });
  it('rejects bytes that do not match the reserved checksum', async () => {
    vi.stubEnv('EVIDENCE_REMOTE_SYNC_ENABLED', 'true');
    const { client, download } = mockClient({ storagePath: 'private/term.jpg', contentType: 'image/jpeg',
      byteSize: 3, checksum: 'a'.repeat(64) });
    download.mockResolvedValue({ data: new Blob([new Uint8Array([0xff, 0xd8, 0xff])]), error: null });
    await expect(confirmScrapAttachment(client as never, 'photo-id', 'device-id', 'key', {
      checksum: 'a'.repeat(64),
    } as never, 'seller-id')).rejects.toMatchObject({ status: 422, code: 'VALIDATION_FAILED' });
  });
});
