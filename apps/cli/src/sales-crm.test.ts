import { describe, expect, it, vi } from 'vitest';
import { calculateClientSales, salesCrmContext } from '@cirne/domain';
import { salesCrmCommand } from './sales-crm';
const id = '41400000-0000-4000-8000-000000000001';
const metadata = { generationId: id, fetchedAt: '2026-11-03T09:15:00Z', publishedAt: '2026-11-03T09:16:00Z',
  asOfDate: '2026-11-03', observedFrom: '2023-01-01', observedThrough: '2026-11-03' };
const result = calculateClientSales({ ...metadata, clientVersion: 1, client: { id, name: 'Sintético' }, rows: [] },
  { historyPage: 1, opportunityPage: 1 }, new Date('2026-11-03T12:00:00Z'));
describe('read-only sales CRM CLI', () => {
  it('reads a typed detail through the authorized BFF with no writes/cache/redirects', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json(result));
    expect(await salesCrmCommand('http://127.0.0.1:3000', 'synthetic-token', { kind: 'client', clientId: id,
      query: { historyPage: 1, opportunityPage: 1 } }, transport)).toEqual(result);
    const [url, options] = transport.mock.calls[0]!;
    expect(String(url)).toContain(`/clients/${id}/sales?historyPage=1&opportunityPage=1`);
    expect(options).toMatchObject({ method: 'GET', redirect: 'error', cache: 'no-store', headers: { authorization: 'Bearer synthetic-token' } });
  });
  it('supports bounded batch signals through the same contract as the UI', async () => {
    const payload = { schemaVersion: 1, ...salesCrmContext(metadata, new Date('2026-11-03T12:00:00Z')),
      sellerId: id, serviceDate: '2026-12-03', signals: [{ client: result.client, metrics: result.metrics }] };
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload));
    expect(await salesCrmCommand('https://example.invalid', 'synthetic-token', { kind: 'signals',
      query: { sellerId: id, serviceDate: payload.serviceDate, clientIds: [id] } }, transport)).toEqual(payload);
    expect(String(transport.mock.calls[0]![0])).toContain('clientIds=');
  });
  it('sanitizes access errors and rejects unsafe origins before sending a token', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ secret: 'must-not-print' }, { status: 403 }));
    const command = { kind: 'client' as const, clientId: id, query: { historyPage: 1, opportunityPage: 1 } };
    await expect(salesCrmCommand('http://127.0.0.1:3000', 'token', command, transport)).rejects.toThrow('HTTP 403');
    transport.mockClear();
    await expect(salesCrmCommand('http://external.invalid', 'token', command, transport)).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
});
