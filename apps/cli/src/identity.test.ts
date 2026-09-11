import { describe, expect, it, vi } from 'vitest';
import { checkIdentity } from './identity';
import { selectIdentityToken } from './identity-input';

const identity = {
  id: 'dcd459e5-5cdc-4745-b239-0a231a9f5cd7',
  displayName: 'Vendedor A Sintético',
  roles: ['seller'],
  capabilities: ['identity.read_self'],
  scopeIds: ['dcd459e5-5cdc-4745-b239-0a231a9f5cd7'],
  status: 'active',
};

describe('identity CLI contract', () => {
  it('sends the bearer and validates a successful response', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(identity));
    await expect(checkIdentity('http://127.0.0.1:3000', 'synthetic-token', request))
      .resolves.toEqual(identity);
    const headers = request.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer synthetic-token');
  });

  it('fails safely for HTTP errors, incompatible bodies and network failures', async () => {
    const errorBody = {
      error: {
        code: 'access_denied',
        message: 'Acesso não autorizado.',
        recoverable: false,
        timestamp: '2026-09-11T12:00:00.000Z',
        requestId: 'bff3dbdf-05ab-4adc-8a23-9707bad2ad6a',
      },
    };
    await expect(checkIdentity('http://127.0.0.1:3000', 'token', vi.fn().mockResolvedValue(Response.json(errorBody, { status: 403 }))))
      .rejects.toThrow('Acesso não autorizado. (HTTP 403).');
    await expect(checkIdentity('http://127.0.0.1:3000', 'token', vi.fn().mockResolvedValue(Response.json({ id: 'invalid' }))))
      .rejects.toThrow('incompatível');
    await expect(checkIdentity('http://127.0.0.1:3000', 'token', vi.fn().mockRejectedValue(new Error('secret token'))))
      .rejects.toThrow('Aplicação inacessível');
  });

  it('rejects unsafe origins and accepts exactly one secret input channel', async () => {
    await expect(checkIdentity('https://user:password@example.com', 'token')).rejects.toThrow('URL inválida');
    await expect(checkIdentity('https://example.com', 'token')).rejects.toThrow('URL inválida');
    await expect(checkIdentity('http://[::1]:3000', 'token', vi.fn().mockResolvedValue(Response.json(identity))))
      .resolves.toEqual(identity);
    expect(selectIdentityToken(' environment-token ', '')).toBe('environment-token');
    expect(selectIdentityToken(undefined, ' stdin-token\n')).toBe('stdin-token');
    expect(() => selectIdentityToken('one', 'two')).toThrow('apenas uma origem');
    expect(() => selectIdentityToken(undefined, '')).toThrow('Token ausente');
  });
});
