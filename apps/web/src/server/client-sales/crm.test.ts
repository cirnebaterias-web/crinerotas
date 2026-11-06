import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { MeResponse } from '@cirne/contracts';
import { salesSyncRpc } from '../sales-sync/http';
import { readClientCatalogMatches, readClientCatalogOpportunities, readClientSalesCatalogContext,
  readClientSalesSnapshot } from './service';
import { getClientSales, getSalesSignals, parseClientSalesQuery, parseSalesSignalsQuery } from './crm';
import { requireSalesRead } from './http';
vi.mock('../sales-sync/http', () => ({ salesSyncRpc: vi.fn() }));
vi.mock('./service', () => ({ readClientSalesSnapshot: vi.fn(), readClientSalesCatalogContext: vi.fn(),
  readClientCatalogMatches: vi.fn(), readClientCatalogOpportunities: vi.fn() }));
const rpc = vi.mocked(salesSyncRpc);
const snapshot = vi.mocked(readClientSalesSnapshot);
const catalogContext = vi.mocked(readClientSalesCatalogContext);
const catalogMatches = vi.mocked(readClientCatalogMatches);
const catalogOpportunities = vi.mocked(readClientCatalogOpportunities);
const db = {} as SupabaseClient;
const id = '41400000-0000-4000-8000-000000000001';
const other = '41400000-0000-4000-8000-000000000002';
const generation = '41400000-0000-4000-8000-000000000003';
const metadata = { generationId: generation, fetchedAt: '2026-11-03T09:15:00Z', publishedAt: '2026-11-03T09:16:00Z',
  observedFrom: '2023-01-01', observedThrough: '2026-11-03', asOfDate: '2026-11-03' };
const customer = { id, name: 'Cliente sintético' };
const query = { sellerId: other, clientIds: [id], serviceDate: '2026-12-10' };
const batch = { ...metadata, sellerId: other, signals: [{ client: customer, lastPurchaseDate: '2026-10-21',
  purchaseDayCount12: 3, intervalTotalDays12: 20, netVolume6: 60 }] };
const now = new Date('2026-11-03T12:00:00Z');
beforeEach(() => {
  rpc.mockReset(); snapshot.mockReset(); catalogContext.mockReset(); catalogMatches.mockReset(); catalogOpportunities.mockReset();
  catalogContext.mockResolvedValue({ ...metadata, salesGenerationId: generation, catalogGenerationId: null,
    clientVersion: 1, client: customer, catalog: { status: 'catalog_unavailable' } });
});

describe('sales CRM BFF', () => {
  it('uses one batch query and never shifts the analytic date to the planned route date', async () => {
    rpc.mockResolvedValue(batch);
    const result = await getSalesSignals(db, query, now);
    expect(rpc).toHaveBeenCalledExactlyOnceWith(db, 'get_sales_route_signals', {
      p_seller_id: other, p_client_ids: [id], p_snapshot_id: null,
    });
    expect(result.asOfDate).toBe('2026-11-03');
    expect(result.serviceDate).toBe('2026-12-10');
    expect(result.signals[0]?.metrics).toMatchObject({ daysSinceLastPurchase: 13, periodicityDays: 10,
      averageMonthlyVolume: 10, cycleState: 'cycle_exceeded' });
  });
  it.each([
    { ...batch, signals: [] }, { ...batch, signals: [batch.signals[0], batch.signals[0]] },
    { ...batch, sellerId: id }, { ...batch, signals: [{ ...batch.signals[0], client: { id: other, name: 'Outro' } }] },
    { ...batch, signals: [{ ...batch.signals[0], externalReference: 'must-not-return' }] },
    { ...batch, signals: [{ ...batch.signals[0], purchaseDayCount12: 3, intervalTotalDays12: 0 }] },
  ])('fails closed on incomplete, overbroad or inconsistent batch output', async (body) => {
    rpc.mockResolvedValue(body);
    await expect(getSalesSignals(db, query, now)).rejects.toMatchObject({ status: 503 });
  });
  it('rejects a changed generation or reference without returning signals', async () => {
    rpc.mockResolvedValue(batch);
    await expect(getSalesSignals(db, { ...query, generationId: other, asOfDate: metadata.asOfDate }, now)).rejects.toMatchObject({ status: 409 });
    await expect(getSalesSignals(db, { ...query, generationId: generation, asOfDate: '2026-11-02' }, now)).rejects.toMatchObject({ status: 409 });
  });
  it('loads a client using shared analytics and pins the full public cursor', async () => {
    snapshot.mockResolvedValue({ ...metadata, clientVersion: 1, client: customer, rows: [], products: [] });
    const read = { historyPage: 1, opportunityPage: 1, salesGenerationId: generation,
      asOfDate: metadata.asOfDate, clientVersion: 1 };
    expect(await getClientSales(db, id, read, now)).toMatchObject({ dataState: 'no_history', metrics: { daysSinceLastPurchase: null } });
    expect(snapshot).toHaveBeenCalledWith(db, id, generation, metadata.asOfDate, 1);
  });
  it('rejects out-of-range pages rather than a misleading empty result', async () => {
    snapshot.mockResolvedValue({ ...metadata, clientVersion: 1, client: customer, rows: [], products: [] });
    await expect(getClientSales(db, id, { historyPage: 2, opportunityPage: 1 }, now)).rejects.toMatchObject({ status: 422 });
  });
  it('retains database denials as denials, never as no-history', async () => {
    const failure = new (await import('../routes/http')).RouteRequestError(404, 'NOT_FOUND', 'Não encontrado.', false);
    catalogContext.mockRejectedValue(failure); rpc.mockRejectedValue(failure);
    await expect(getClientSales(db, id, { historyPage: 1, opportunityPage: 1 }, now)).rejects.toBe(failure);
    await expect(getSalesSignals(db, query, now)).rejects.toBe(failure);
  });
  it('accepts only bounded, unambiguous query fields', () => {
    expect(parseClientSalesQuery('https://app.invalid/api')).toEqual({ historyPage: 1, opportunityPage: 1 });
    expect(parseSalesSignalsQuery(`https://app.invalid/api?sellerId=${other}&serviceDate=2026-11-03&clientIds=${id}`)).toMatchObject({ clientIds: [id] });
    for (const suffix of ['?historyPage=2', '?historyPage=1&historyPage=2', '?document=123', '?historyPage=0']) {
      expect(() => parseClientSalesQuery(`https://app.invalid/api${suffix}`)).toThrow();
    }
  });
  it('requires explicit read authority and additional planning capability without admin shortcut', () => {
    const identity = (capabilities: string[]) => ({ capabilities } as MeResponse);
    expect(() => requireSalesRead(identity([]))).toThrow();
    expect(() => requireSalesRead(identity(['sales.sync']))).toThrow();
    expect(() => requireSalesRead(identity(['sales.read_client']))).not.toThrow();
    expect(() => requireSalesRead(identity(['sales.read_client']), true)).toThrow();
    expect(() => requireSalesRead(identity(['sales.read_client', 'route.plan_scoped']), true)).not.toThrow();
  });
});
