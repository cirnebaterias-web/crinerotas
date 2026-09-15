import { describe, expect, it, vi } from 'vitest';
import type { SyncBatchRequest } from '@cirne/contracts';
import { runSyncRoundTrip } from './sync';

describe('sync round-trip CLI contract', () => {
  it('proves confirmation, exact replay and divergent-key rejection without returning content', async () => {
    let canonical: object | undefined;
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      const batch = JSON.parse(String(init?.body)) as SyncBatchRequest;
      const command = batch.events[0]!;
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer synthetic-private-token');
      if (!canonical) {
        canonical = {
          eventId: command.eventId,
          status: 'confirmed',
          canonicalId: command.aggregateId,
          confirmedAt: '2026-09-14T12:01:00.000Z',
        };
      }
      return Response.json(command.payload.acknowledged ? {
        requestId: crypto.randomUUID(),
        results: [canonical],
      } : {
        requestId: crypto.randomUUID(),
        results: [{
          eventId: command.eventId,
          status: 'rejected',
          error: {
            code: 'IDEMPOTENCY_KEY_REUSED',
            message: 'A chave de idempotência já foi usada com outro conteúdo.',
            recoverable: false,
          },
        }],
      });
    });

    const result = await runSyncRoundTrip(
      'http://127.0.0.1:3000',
      'synthetic-private-token',
      request,
    );
    expect(result).toEqual({
      status: 'ok',
      checks: { firstConfirmation: true, replayMatched: true, divergentRejected: true },
    });
    expect(JSON.stringify(result)).not.toMatch(/token|payload|eventId|idempotency/i);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('rejects unsafe origins, missing tokens and incompatible responses', async () => {
    await expect(runSyncRoundTrip('https://example.com', 'token')).rejects.toThrow('URL inválida');
    await expect(runSyncRoundTrip('http://127.0.0.1:3000', '')).rejects.toThrow('Token ausente');
    await expect(runSyncRoundTrip(
      'http://127.0.0.1:3000',
      'token',
      vi.fn().mockResolvedValue(Response.json({ unexpected: true })),
    )).rejects.toThrow('incompatível');
  });
});
