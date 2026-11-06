import { describe, expect, it, vi } from 'vitest';
import { normalizeSalesRows, type SalesProjectedRow } from '@cirne/domain';
import type { SalesSyncResult } from '@cirne/contracts';
import { salesContentHash, salesStageChunks, salesSyncCommand } from './sales-sync';

const id = '11111111-1111-4111-8111-111111111111';
const lease = '22222222-2222-4222-8222-222222222222';
const env = { GOOGLE_SALES_SYNC_ENABLED: 'true', GOOGLE_SALES_SYNC_SPREADSHEET_ID: 'synthetic_sheet_identifier_123',
  GOOGLE_SALES_SYNC_SERVICE_ACCOUNT_EMAIL: 'test@synthetic.iam.gserviceaccount.com',
  GOOGLE_SALES_SYNC_PRIVATE_KEY: 'x'.repeat(100), GOOGLE_SALES_SYNC_SCHEDULER_ACTOR_ID: id };
const command = { trigger: 'manual' as const, idempotencyKey: id };
const result: SalesSyncResult = { id, sourceKey: 'a'.repeat(64), status: 'collecting', trigger: 'manual',
  startedAt: '2026-11-03T09:15:00Z', completedAt: null, generationId: null, contentHash: null, parserVersion: null,
  sourceRowCount: 0, stagedRowCount: 0, unmatchedClientCount: 0, issueCount: 0,
  observedMinDate: null, observedMaxDate: null, errorCode: null };
function source(count = 1): SalesProjectedRow[] {
  return Array.from({ length: count }, (_, i) => ({ sourceRow: i + 2, cells: {
    clientExternalReference: '00000000001', invoiceNumber: `NF-${i}`, saleDate: '5/12/2023', sku: 'SKU-1',
    volume: '2', totalAmount: '200,00', productDescription: 'Bateria sintética', itemGroup: 'SLI',
    itemSubgroup: '', category: 'Leve', brand: 'Marca', line: '', kind: 'Venda', externalKey: `key-${i}`,
  } }));
}
const begin = () => Response.json({ runId: id, leaseToken: lease, replayed: false, result });
describe('sales acquisition orchestration', () => {
  it('publishes only after two complete matching passes and bounded stages', async () => {
    const requests: { path: string; body: Record<string, unknown> }[] = [];
    const transport = vi.fn<typeof fetch>(async (url, init) => {
      const path = new URL(String(url)).pathname;
      const body = JSON.parse(String(init!.body)) as Record<string, unknown>; requests.push({ path, body });
      if (path.endsWith('/runs')) return begin();
      if (path.endsWith('/stage')) return Response.json({ stagedCount: 26000, replayed: false });
      return Response.json({ ...result, status: 'published', generationId: id, sourceRowCount: 26000, stagedRowCount: 26000 });
    });
    const readSheet = vi.fn(async () => source(26000));
    const output = await salesSyncCommand('http://localhost:3000', 'token', command, { env, transport, readSheet });
    expect(readSheet).toHaveBeenCalledTimes(2);
    expect(requests.filter((request) => request.path.endsWith('/stage'))).toHaveLength(52);
    expect(requests.at(-1)!.body.expectedRowCount).toBe(26000);
    expect(output).toMatchObject({ status: 'published' });
  }, 15000);
  it('records changed-source failure without staging or publishing', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(begin()).mockResolvedValueOnce(Response.json({ ...result, status: 'failed', errorCode: 'SOURCE_CHANGED' }));
    const changed = source(); changed[0]!.cells.volume = '3';
    const readSheet = vi.fn().mockResolvedValueOnce(source()).mockResolvedValueOnce(changed);
    await expect(salesSyncCommand('http://localhost:3000', 'token', command, { env, transport, readSheet })).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    expect(String(transport.mock.calls[1]![0])).toContain('/fail');
    expect(JSON.parse(String(transport.mock.calls[1]![1]!.body))).toMatchObject({ errorCode: 'SOURCE_CHANGED' });
  });
  it('recovers a published replay without reading Google or producing a second write', async () => {
    const readSheet = vi.fn();
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ runId: id, leaseToken: null, replayed: true, result: { ...result, status: 'published' } }));
    await expect(salesSyncCommand('http://localhost:3000', 'token', command, { env, transport, readSheet })).resolves.toMatchObject({ status: 'published' });
    expect(readSheet).not.toHaveBeenCalled(); expect(transport).toHaveBeenCalledTimes(1);
  });
  it('resumes a lost begin response with the same valid lease and idempotent chunks', async () => {
    const readSheet = vi.fn(async () => source());
    const transport = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('connection lost'))
      .mockResolvedValueOnce(Response.json({ runId: id, leaseToken: lease, replayed: true, result }))
      .mockResolvedValueOnce(Response.json({ stagedCount: 1, replayed: true }))
      .mockResolvedValueOnce(Response.json({ ...result, status: 'published' }));
    await expect(salesSyncCommand('http://localhost:3000', 'token', command,
      { env, transport, readSheet, sleep: async () => undefined })).resolves.toMatchObject({ status: 'published' });
    expect(transport.mock.calls[0]![1]!.body).toBe(transport.mock.calls[1]![1]!.body);
    expect(readSheet).toHaveBeenCalledTimes(2);
  });
  it('preserves an ambiguous publish after exhausted retries; never marks it failed', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(begin())
      .mockResolvedValueOnce(Response.json({ stagedCount: 1, replayed: false }))
      .mockRejectedValue(new TypeError('secret provider payload'));
    await expect(salesSyncCommand('http://localhost:3000', 'token', command,
      { env, transport, readSheet: async () => source(), sleep: async () => undefined })).rejects.toThrow('Não foi possível concluir');
    expect(transport).toHaveBeenCalledTimes(5);
    expect(transport.mock.calls.some(([url]) => String(url).endsWith('/fail'))).toBe(false);
    expect(new Set(transport.mock.calls.slice(2).map(([, init]) => init!.body)).size).toBe(1);
  });
  it('computes hashes over actual ordered tuples and splits byte-heavy Unicode chunks', () => {
    const rows = normalizeSalesRows(source(1500)).map((row) => ({ ...row, productDescription: '界'.repeat(240),
      externalKey: `${row.sourceRow}-${'界'.repeat(240)}`, itemGroup: '界'.repeat(80), itemSubgroup: '界'.repeat(80),
      brand: '界'.repeat(80), category: '界'.repeat(80), line: '界'.repeat(80), invoiceNumber: '界'.repeat(80), sku: '界'.repeat(80) }));
    const chunks = salesStageChunks(rows, lease);
    expect(chunks.flatMap((chunk) => chunk.rows)).toEqual(rows);
    expect(chunks.every((chunk) => chunk.rows.length <= 500 && Buffer.byteLength(JSON.stringify(chunk)) <= 1024 * 1024)).toBe(true);
    expect(salesContentHash(rows)).not.toBe(salesContentHash([...rows].reverse()));
    expect(salesContentHash(rows)).not.toBe(salesContentHash(rows.map((row) => ({ ...row, volume: 3 }))));
  });
  it('rejects disabled configuration without starting a run', async () => {
    const transport = vi.fn<typeof fetch>();
    await expect(salesSyncCommand('http://localhost:3000', 'token', command, { env: {}, transport })).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
});
