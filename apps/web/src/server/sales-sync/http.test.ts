import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { MeResponse } from '@cirne/contracts';
import { readSalesSyncJson, requireSalesSyncCapability, salesSyncRpc } from './http';

describe('sales HTTP boundary', () => {
  it('does not inherit sales ingestion from client-import capability', () => {
    const identity: MeResponse = { id: '11111111-1111-4111-8111-111111111111', displayName: 'Sintético',
      roles: ['manager'], capabilities: ['clients.import'], scopeIds: [], status: 'active' };
    expect(() => requireSalesSyncCapability(identity)).toThrow('Operação não autorizada');
    expect(() => requireSalesSyncCapability({ ...identity, capabilities: ['sales.sync'] })).not.toThrow();
  });
  it('accepts explicitly bounded 1MiB JSON and denies both advertised and streamed excess', async () => {
    const request = (text: string, headers = {}) => new Request('http://localhost/api', { method: 'POST',
      headers: { 'content-type': 'application/json', ...headers }, body: text });
    await expect(readSalesSyncJson(request(JSON.stringify({ data: 'a'.repeat(100000) })))).resolves.toHaveProperty('data');
    await expect(readSalesSyncJson(request('{}', { 'content-length': '1048577' }))).rejects.toMatchObject({ status: 413 });
    await expect(readSalesSyncJson(request(JSON.stringify({ data: 'a'.repeat(1048576) })))).rejects.toMatchObject({ status: 413 });
  });
  it('rejects malformed bodies and media types without echoing contents', async () => {
    await expect(readSalesSyncJson(new Request('http://localhost', { method: 'POST', body: 'secret' }))).rejects.toMatchObject({ status: 415 });
    await expect(readSalesSyncJson(new Request('http://localhost', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'secret' }))).rejects.toMatchObject({ status: 400 });
  });
  it.each(['FORBIDDEN', 'SYNC_BUSY', 'SYNC_LEASE_EXPIRED', 'unrecognized sensitive SQL error'])('sanitizes RPC error %s', async (message) => {
    const client = { schema: vi.fn(() => ({ rpc: vi.fn(() => ({ abortSignal: vi.fn(async () => ({ data: null,
      error: { code: 'P0001', message, details: 'private document', hint: 'private token' } })) })) })) } as unknown as SupabaseClient;
    try { await salesSyncRpc(client, 'stage_sales_sheet_sync', {}); expect.fail(); }
    catch (error) {
      expect(String(error)).not.toContain('private'); expect(String(error)).not.toContain('sensitive SQL');
      expect(error).toHaveProperty('status', message === 'FORBIDDEN' ? 403 : message.startsWith('SYNC_') ? 409 : 503);
    }
  });
  it('distinguishes authorized but uninitialized history without echoing database details', async () => {
    const client = { schema: vi.fn(() => ({ rpc: vi.fn(() => ({ abortSignal: vi.fn(async () => ({ data: null,
      error: { code: 'P0001', message: 'SALES_UNAVAILABLE', details: 'private source', hint: 'private actor' } })) })) })) } as unknown as SupabaseClient;
    await expect(salesSyncRpc(client, 'get_client_sales_page', {})).rejects.toMatchObject({ status: 503,
      code: 'DEPENDENCY_UNAVAILABLE', recoverable: false, details: { reason: 'no_published_generation' } });
  });
});
