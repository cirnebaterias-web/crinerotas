import { describe, expect, it, vi } from 'vitest';
import { mutationHeaders, requireScrapAccess, scrapRpc } from './http';

describe('scrap authorization and idempotency boundary', () => {
  it('requires explicit receive capability even for administrators', () => {
    expect(() => requireScrapAccess({ roles: ['administrator'], capabilities: ['scrap.read_operations'] } as never,
      'scrap.receive')).toThrow('Operação não autorizada.');
    expect(() => requireScrapAccess({ roles: ['logistics'], capabilities: ['scrap.receive'] } as never,
      'scrap.receive')).not.toThrow();
  });
  it('rejects non-UUID replay keys and missing device identity', () => {
    expect(() => mutationHeaders(new Request('https://example.test', {
      headers: { 'idempotency-key': 'invalid' },
    }))).toThrow('Identificação da operação inválida.');
    const request = new Request('https://example.test', {
      headers: { 'idempotency-key': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    });
    expect(() => mutationHeaders(request)).toThrow();
    expect(mutationHeaders(request, false).idempotencyKey).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  });
  it('preserves concurrency conflict and redacts unexpected database messages', async () => {
    const abortSignal = vi.fn().mockResolvedValueOnce({ data: null,
      error: { code: 'P0001', message: 'VERSION_CONFLICT' } }).mockResolvedValueOnce({ data: null,
      error: { code: 'XX000', message: 'private details' } });
    const client = { schema: vi.fn(() => ({ rpc: vi.fn(() => ({ abortSignal })) })) };
    await expect(scrapRpc(client as never, 'confirm_scrap_receipt')).rejects.toMatchObject({ status: 409, code: 'VERSION_CONFLICT' });
    await expect(scrapRpc(client as never, 'confirm_scrap_receipt')).rejects.toMatchObject({
      status: 503, code: 'DEPENDENCY_UNAVAILABLE', message: 'Sucata temporariamente indisponível.',
    });
  });
});
