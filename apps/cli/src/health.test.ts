import { describe, expect, it, vi } from 'vitest';
import { checkLive } from './health';

describe('HTTP canary client', () => {
  it('uses the shared route, timeout, and refuses redirects', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ status: 'ok' }));
    await expect(checkLive('http://localhost:3000', request)).resolves.toEqual({ status: 'ok' });
    expect(String(request.mock.calls[0]?.[0])).toBe('http://localhost:3000/api/v1/health/live');
    expect(request.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error', signal: expect.any(AbortSignal) });
  });
  it('reports network failure without leaking original error', async () => {
    await expect(checkLive('http://localhost', vi.fn().mockRejectedValue(new Error('secret-token')))).rejects.toThrow('Aplicação inacessível');
  });
  it('reports failed HTTP and invalid JSON/schema without reflecting body', async () => {
    await expect(checkLive('http://localhost', vi.fn().mockResolvedValue(new Response('secret', { status: 503 })))).rejects.toThrow('HTTP 503');
    for (const response of [new Response('private'), Response.json({ status: 'ok', private: 'private' })]) {
      await expect(checkLive('http://localhost', vi.fn().mockResolvedValue(response))).rejects.toThrow('incompatível');
    }
  });
  it('rejects credentials, paths, and non HTTP protocols before fetching', async () => {
    const request = vi.fn();
    for (const url of ['file:///tmp', 'http://user:secret@localhost', 'http://localhost/api', 'http://localhost?token=private']) await expect(checkLive(url, request)).rejects.toThrow('URL inválida');
    expect(request).not.toHaveBeenCalled();
  });
});
