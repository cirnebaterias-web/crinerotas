import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { clientImportRpc } from '../client-imports/http';
import { RouteRequestError } from '../routes/http';
import {
  clientRequestOrigin,
  requireClientId,
  requireClientIdempotencyKey,
} from './service';

function failingClient(message: string, details = '') {
  return {
    schema: () => ({
      rpc: () => ({
        abortSignal: async () => ({ data: null, error: { code: 'P0001', message, details } }),
      }),
    }),
  } as unknown as SupabaseClient;
}

describe('client BFF service boundary', () => {
  it('distinguishes CLI origin and validates identifiers', () => {
    expect(clientRequestOrigin(new Request('http://localhost'))).toBe('web');
    expect(clientRequestOrigin(new Request('http://localhost', {
      headers: { authorization: 'Bearer synthetic-token' },
    }))).toBe('cli');
    expect(requireClientId('10000000-0000-4000-8000-000000000001'))
      .toBe('10000000-0000-4000-8000-000000000001');
    expect(() => requireClientId('invalid')).toThrow(RouteRequestError);
    expect(requireClientIdempotencyKey(new Request('http://localhost', {
      headers: { 'idempotency-key': '20000000-0000-4000-8000-000000000001' },
    }))).toBe('20000000-0000-4000-8000-000000000001');
    expect(() => requireClientIdempotencyKey(new Request('http://localhost'))).toThrow(RouteRequestError);
  });

  it('maps an authorized version conflict with its current canonical state', async () => {
    const current = { schemaVersion: 1, id: '10000000-0000-4000-8000-000000000001' };
    await expect(clientImportRpc(failingClient('VERSION_CONFLICT', JSON.stringify({ current })), 'update_client'))
      .rejects.toMatchObject({ status: 409, code: 'VERSION_CONFLICT', details: { current } });
  });

  it('does not invent details for a hidden duplicate and maps seller validation', async () => {
    await expect(clientImportRpc(failingClient('VERSION_CONFLICT'), 'create_client'))
      .rejects.toMatchObject({ status: 409, code: 'VERSION_CONFLICT', details: undefined });
    await expect(clientImportRpc(failingClient('SELLER_NOT_FOUND'), 'create_client'))
      .rejects.toMatchObject({ status: 422, code: 'VALIDATION_FAILED' });
  });
});
