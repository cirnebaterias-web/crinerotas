import { describe, expect, it, vi } from 'vitest';
import type { CookieMethodsServer } from '@supabase/ssr';
import {
  IdentityRequestError,
  authCookiePrefix,
  parseBearer,
  resolveIdentityRequest,
  type IdentityResolvers,
} from './identity';

const identity = {
  id: 'dcd459e5-5cdc-4745-b239-0a231a9f5cd7',
  displayName: 'Vendedor A Sintético',
  roles: ['seller'],
  capabilities: ['identity.read_self'],
  scopeIds: ['dcd459e5-5cdc-4745-b239-0a231a9f5cd7'],
  status: 'active',
};

function cookieMethods(names: string[] = []): CookieMethodsServer {
  return { getAll: () => names.map((name) => ({ name, value: 'redacted' })), setAll: vi.fn() };
}

function resolvers(value: unknown = identity, userId: string | null = identity.id): IdentityResolvers {
  return {
    bearer: vi.fn().mockResolvedValue({ userId, identity: value }),
    cookie: vi.fn().mockResolvedValue({ userId, identity: value }),
  };
}

describe('identity request resolution', () => {
  it('accepts one strict bearer and validates the returned actor', async () => {
    const deps = resolvers();
    await expect(resolveIdentityRequest('Bearer synthetic-token', cookieMethods(), deps))
      .resolves.toEqual(identity);
    expect(deps.bearer).toHaveBeenCalledWith('synthetic-token');
  });

  it('accepts the Supabase session cookie without treating unrelated cookies as auth', async () => {
    const deps = resolvers();
    const prefix = authCookiePrefix('http://127.0.0.1:54321');
    await expect(resolveIdentityRequest(null, cookieMethods([`${prefix}.0`]), deps, 'http://127.0.0.1:54321'))
      .resolves.toEqual(identity);
    expect(deps.cookie).toHaveBeenCalled();
    await expect(resolveIdentityRequest(null, cookieMethods(['theme']), deps, 'http://127.0.0.1:54321'))
      .rejects.toMatchObject({ status: 401 });
    await expect(resolveIdentityRequest(
      null,
      cookieMethods([`${prefix}-code-verifier`]),
      deps,
      'http://127.0.0.1:54321',
    )).rejects.toMatchObject({ status: 401 });
  });

  it('rejects missing, malformed, duplicated or conflicting credentials', async () => {
    expect(parseBearer(null)).toBeNull();
    for (const value of ['', 'Basic abc', 'Bearer ', 'Bearer one two', 'Bearer one,two']) {
      expect(() => parseBearer(value)).toThrow(IdentityRequestError);
    }
    await expect(resolveIdentityRequest('Bearer token', cookieMethods(['sb-127-auth-token']), resolvers(), 'http://127.0.0.1:54321'))
      .rejects.toMatchObject({ status: 400, code: 'conflicting_credentials' });
  });

  it('fails closed for invalid users, blocked contexts, contract drift and identity mismatch', async () => {
    await expect(resolveIdentityRequest('Bearer token', cookieMethods(), resolvers(identity, null)))
      .rejects.toMatchObject({ status: 401 });
    await expect(resolveIdentityRequest('Bearer token', cookieMethods(), resolvers(null)))
      .rejects.toMatchObject({ status: 403 });
    await expect(resolveIdentityRequest('Bearer token', cookieMethods(), resolvers({ ...identity, token: 'leak' })))
      .rejects.toMatchObject({ status: 503 });
    await expect(resolveIdentityRequest('Bearer token', cookieMethods(), resolvers({ ...identity, id: '57b2a846-7eaa-4fec-ab11-8e138b2008d3' })))
      .rejects.toMatchObject({ status: 403 });
  });
});
