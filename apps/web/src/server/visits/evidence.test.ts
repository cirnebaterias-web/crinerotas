import { afterEach, describe, expect, it, vi } from 'vitest';
import { confirmEvidenceAttachment, saveVisitCheckinEvidence } from './evidence';

function clientWithRpcError(error: { code: string; message: string }) {
  const abortSignal = vi.fn().mockResolvedValue({ data: null, error });
  const rpc = vi.fn(() => ({ abortSignal }));
  return { client: { schema: vi.fn(() => ({ rpc })) }, rpc };
}

function clientWithDownload(result: { data: null; error: { statusCode: number } }) {
  const abortSignal = vi.fn().mockResolvedValue({ data: { storagePath: 'seller/visit/photo.jpg' }, error: null });
  const download = vi.fn().mockResolvedValue(result);
  return {
    client: {
      schema: vi.fn(() => ({ rpc: vi.fn(() => ({ abortSignal })) })),
      storage: { from: vi.fn(() => ({ download })) },
    },
  };
}

afterEach(() => vi.unstubAllEnvs());

describe('visit evidence RPC failures', () => {
  it('preserves a recoverable out-of-order business failure', async () => {
    vi.stubEnv('EVIDENCE_REMOTE_SYNC_ENABLED', 'true');
    const { client } = clientWithRpcError({ code: 'P0001', message: 'EVENT_OUT_OF_ORDER' });

    await expect(saveVisitCheckinEvidence(
      client as never, 'device-id', 'idempotency-key', {} as never,
    )).rejects.toMatchObject({ code: 'EVENT_OUT_OF_ORDER', recoverable: true });
  });

  it('preserves a non-recoverable validation business failure', async () => {
    vi.stubEnv('EVIDENCE_REMOTE_SYNC_ENABLED', 'true');
    const { client } = clientWithRpcError({ code: 'P0001', message: 'VALIDATION_FAILED' });

    await expect(saveVisitCheckinEvidence(
      client as never, 'device-id', 'idempotency-key', {} as never,
    )).rejects.toMatchObject({ code: 'VALIDATION_FAILED', recoverable: false });
  });

  it('redacts unrecognized database failures as dependency unavailable', async () => {
    vi.stubEnv('EVIDENCE_REMOTE_SYNC_ENABLED', 'true');
    const { client } = clientWithRpcError({ code: 'XX000', message: 'private database detail' });

    await expect(saveVisitCheckinEvidence(
      client as never, 'device-id', 'idempotency-key', {} as never,
    )).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE', recoverable: true });
  });

  it('keeps transient Storage failures recoverable', async () => {
    vi.stubEnv('EVIDENCE_REMOTE_SYNC_ENABLED', 'true');
    const { client } = clientWithDownload({ data: null, error: { statusCode: 503 } });

    await expect(confirmEvidenceAttachment(
      client as never, 'attachment-id', 'device-id', 'idempotency-key', {} as never, 'seller-id',
    )).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE', recoverable: true });
  });

  it('treats a missing Storage object as invalid evidence', async () => {
    vi.stubEnv('EVIDENCE_REMOTE_SYNC_ENABLED', 'true');
    const { client } = clientWithDownload({ data: null, error: { statusCode: 404 } });

    await expect(confirmEvidenceAttachment(
      client as never, 'attachment-id', 'device-id', 'idempotency-key', {} as never, 'seller-id',
    )).rejects.toMatchObject({ code: 'VALIDATION_FAILED', recoverable: false });
  });
});
