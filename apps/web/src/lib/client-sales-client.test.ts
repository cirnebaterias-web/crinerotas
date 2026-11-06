import { afterEach, describe, expect, it, vi } from 'vitest';
import { clientSalesClient, ClientSalesHttpError, salesErrorMessage } from './client-sales-client';
import { syntheticClientSales } from '../features/clients/client-sales-fixture';

afterEach(() => vi.unstubAllGlobals());
describe('private CRM HTTP reads', () => {
  it('pins the generation, civil reference and client version on subsequent pages, without cache', async () => {
    const data = syntheticClientSales();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(data)));
    vi.stubGlobal('fetch', fetchMock);
    const signal = new AbortController().signal;
    await clientSalesClient.detail(data.client.id, { salesGenerationId: data.salesGenerationId,
      catalogState: data.catalog.status,
      catalogGenerationId: data.catalog.status === 'available' ? data.catalog.generationId : undefined,
      asOfDate: data.asOfDate,
      clientVersion: 1, historyPage: 2, opportunityPage: 1 }, signal);
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toContain('clientVersion=1'); expect(url).toContain('historyPage=2');
    expect(url).toContain(`salesGenerationId=${data.salesGenerationId}`);
    expect(url).toContain(`catalogState=${data.catalog.status}`);
    expect(url).toContain(`catalogGenerationId=${data.catalog.status === 'available' ? data.catalog.generationId : ''}`);
    expect(url).toContain(`asOfDate=${data.asOfDate}`);
    expect(options).toMatchObject({ cache: 'no-store', credentials: 'same-origin' });
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });
  it('uses only the explicitly supplied visible IDs for signal reads', async () => {
    const data = syntheticClientSales();
    const context = { schemaVersion: 1, generationId: data.salesGenerationId, fetchedAt: data.fetchedAt,
      publishedAt: data.publishedAt, observedFrom: data.observedFrom, observedThrough: data.observedThrough,
      asOfDate: data.asOfDate, coverageStatus: data.coverageStatus, coverageLimited: data.coverageLimited,
      stale: data.stale, staleAfterHours: data.staleAfterHours, windows: data.windows };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...context, sellerId: data.client.id,
      serviceDate: '2026-11-04', signals: [{ client: data.client, metrics: data.metrics }] })));
    vi.stubGlobal('fetch', fetchMock);
    await clientSalesClient.signals({ sellerId: data.client.id, serviceDate: '2026-11-04', clientIds: [data.client.id] });
    expect(fetchMock.mock.calls[0]![0]).toContain(`clientIds=${data.client.id}`);
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ cache: 'no-store' });
  });
  it('keeps first-generation unavailability distinct from empty history and discards provider text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: {
      details: { reason: 'no_published_generation' }, message: 'private provider information',
    } }), { status: 503 })));
    await expect(clientSalesClient.detail(syntheticClientSales().client.id)).rejects.toMatchObject({ status: 503, reason: 'no_published_generation' });
    expect(salesErrorMessage(new ClientSalesHttpError(503, 'no_published_generation'))).toBe('Histórico ainda não disponibilizado.');
    expect(salesErrorMessage(new ClientSalesHttpError(409))).toContain('única geração');
    expect(salesErrorMessage(new ClientSalesHttpError(403))).toContain('autorização');
  });
});
