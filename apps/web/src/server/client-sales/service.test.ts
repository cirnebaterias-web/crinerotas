import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { RouteRequestError } from '../routes/http';
import { salesSyncRpc } from '../sales-sync/http';
import { readClientSalesSnapshot } from './service';

vi.mock('../sales-sync/http', () => ({ salesSyncRpc: vi.fn() }));
const rpc = vi.mocked(salesSyncRpc);
const client = {} as SupabaseClient;
const id = '41400000-0000-4000-8000-000000000001';
const generationId = '41400000-0000-4000-8000-000000000002';
const secondGeneration = '41400000-0000-4000-8000-000000000003';
const metadata = { clientVersion: 1, generationId, fetchedAt: '2026-11-03T09:15:00Z', publishedAt: '2026-11-03T09:15:10Z',
  observedFrom: '2023-01-01', observedThrough: '2026-11-01', asOfDate: '2026-11-03',
  client: { id, name: 'Cliente sintético' } };
const product = { sku: '0001', productDescription: 'Bateria sintética', itemGroup: 'SLI', itemSubgroup: '',
  category: 'Leve', brand: '', line: '' };
const row = { ...product, invoiceNumber: 'NF-1', saleDate: '2026-10-01', kind: 'sale', volume: 2, totalAmount: '200.00' };
const facts = { ...metadata, rows: [row], nextAfterRow: null };
const catalog = { clientVersion: 1, generationId, asOfDate: metadata.asOfDate, products: [product], nextAfterSku: null };
const conflict = () => new RouteRequestError(409, 'VERSION_CONFLICT', 'Snapshot changed', true);

beforeEach(() => { rpc.mockReset(); });
describe('authorized complete sales snapshot', () => {
  it('pins every page and product projection to the first generation', async () => {
    rpc.mockResolvedValueOnce({ ...facts, nextAfterRow: 500 })
      .mockResolvedValueOnce({ ...facts, rows: [{ ...row, invoiceNumber: 'NF-2' }] })
      .mockResolvedValueOnce({ ...catalog, nextAfterSku: product.sku })
      .mockResolvedValueOnce({ ...catalog, products: [{ ...product, sku: '0002' }] });
    const result = await readClientSalesSnapshot(client, id);
    expect(result.rows).toHaveLength(2);
    expect(result.products.map((item) => item.sku)).toEqual(['0001', '0002']);
    expect(rpc.mock.calls.map((call) => call[2])).toEqual([
      { p_client_id: id, p_snapshot_id: null, p_after_row: 0 },
      { p_client_id: id, p_snapshot_id: generationId, p_after_row: 500 },
      { p_client_id: id, p_snapshot_id: generationId, p_after_sku: null },
      { p_client_id: id, p_snapshot_id: generationId, p_after_sku: '0001' },
    ]);
  });
  it('discards all partial data and retries once after publication changes', async () => {
    rpc.mockResolvedValueOnce({ ...facts, nextAfterRow: 500 }).mockRejectedValueOnce(conflict())
      .mockResolvedValueOnce({ ...facts, generationId: secondGeneration, rows: [] })
      .mockResolvedValueOnce({ ...catalog, generationId: secondGeneration });
    const result = await readClientSalesSnapshot(client, id);
    expect(result.rows).toEqual([]);
    expect(result.generationId).toBe(secondGeneration);
    expect(rpc.mock.calls[2]?.[2]?.p_snapshot_id).toBeNull();
  });
  it('returns conflict after two concurrent changes, never a partial snapshot', async () => {
    rpc.mockRejectedValue(conflict());
    await expect(readClientSalesSnapshot(client, id)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(rpc).toHaveBeenCalledTimes(2);
  });
  it('does not retry into another generation for an explicitly pinned consumer', async () => {
    rpc.mockRejectedValue(conflict());
    await expect(readClientSalesSnapshot(client, id, generationId)).rejects.toMatchObject({ status: 409 });
    expect(rpc).toHaveBeenCalledExactlyOnceWith(client, 'get_client_sales_page', {
      p_client_id: id, p_snapshot_id: generationId, p_after_row: 0,
    });
  });
  it('fails closed if the current identity loses scope between pages', async () => {
    rpc.mockResolvedValueOnce({ ...facts, nextAfterRow: 500 })
      .mockRejectedValueOnce(new RouteRequestError(403, 'FORBIDDEN', 'Denied', false));
    await expect(readClientSalesSnapshot(client, id)).rejects.toMatchObject({ status: 403 });
    expect(rpc).toHaveBeenCalledTimes(2);
  });
  it('distinguishes unavailable generation from a customer with no facts', async () => {
    rpc.mockRejectedValueOnce(new RouteRequestError(404, 'NOT_FOUND', 'No generation', false));
    await expect(readClientSalesSnapshot(client, id)).rejects.toMatchObject({ status: 404 });
    rpc.mockResolvedValueOnce({ ...facts, rows: [] }).mockResolvedValueOnce(catalog);
    expect((await readClientSalesSnapshot(client, id)).rows).toEqual([]);
  });
  it.each([
    { ...facts, rows: [{ ...row, clientExternalReference: '00000000000191' }] },
    { ...facts, client: { id: secondGeneration, name: 'Outro cliente' } },
    { ...facts, rows: [], nextAfterRow: 5 },
    { ...facts, rows: [{ ...row, totalAmount: 200 }] },
  ])('rejects malformed/overbroad projections without leaking their values', async (page) => {
    rpc.mockResolvedValueOnce(page);
    await expect(readClientSalesSnapshot(client, id)).rejects.toMatchObject({ status: 503 });
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it('rejects non-progressing row cursors', async () => {
    rpc.mockResolvedValue({ ...facts, nextAfterRow: 500 });
    await expect(readClientSalesSnapshot(client, id)).rejects.toMatchObject({ status: 503 });
    expect(rpc).toHaveBeenCalledTimes(2);
  });
  it('rejects duplicate product pages', async () => {
    rpc.mockResolvedValueOnce(facts).mockResolvedValue({ ...catalog, nextAfterSku: '0001' });
    await expect(readClientSalesSnapshot(client, id)).rejects.toMatchObject({ status: 503 });
    expect(rpc).toHaveBeenCalledTimes(3);
  });
  it('does not query invalid identifiers', async () => {
    await expect(readClientSalesSnapshot(client, 'invalid')).rejects.toMatchObject({ status: 422 });
    expect(rpc).not.toHaveBeenCalled();
  });
  it.each(['2026-12-01', '2027-01-01'])('discards data across midnight/month/year (%s)', async (nextDate) => {
    rpc.mockResolvedValueOnce(facts).mockResolvedValueOnce({ ...catalog, asOfDate: nextDate })
      .mockResolvedValueOnce({ ...facts, asOfDate: nextDate }).mockResolvedValueOnce({ ...catalog, asOfDate: nextDate });
    expect((await readClientSalesSnapshot(client, id)).asOfDate).toBe(nextDate);
    expect(rpc).toHaveBeenCalledTimes(4);
  });
  it('rejects a pinned date after midnight without joining product results', async () => {
    rpc.mockResolvedValueOnce({ ...facts, asOfDate: '2026-11-04' });
    await expect(readClientSalesSnapshot(client, id, generationId, '2026-11-03')).rejects.toMatchObject({ status: 409 });
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it('discards all facts if the client binding changes between facts and products', async () => {
    rpc.mockResolvedValueOnce(facts).mockResolvedValueOnce({ ...catalog, clientVersion: 2 })
      .mockResolvedValueOnce({ ...facts, clientVersion: 2, rows: [] }).mockResolvedValueOnce({ ...catalog, clientVersion: 2 });
    const result = await readClientSalesSnapshot(client, id);
    expect(result.rows).toEqual([]);
    expect(result.clientVersion).toBe(2);
  });
  it('rejects the prior client binding on a pinned history page', async () => {
    rpc.mockResolvedValueOnce({ ...facts, clientVersion: 2 });
    await expect(readClientSalesSnapshot(client, id, generationId, metadata.asOfDate, 1)).rejects.toMatchObject({ status: 409 });
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
