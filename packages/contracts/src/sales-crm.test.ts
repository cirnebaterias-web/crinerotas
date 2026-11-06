import { describe, expect, it } from 'vitest';
import { clientSalesQuerySchema, salesSignalsQuerySchema } from './sales-crm';
const id = '41400000-0000-4000-8000-000000000001';
describe('sales CRM request context', () => {
  it('requires generation and reference together and on subsequent pages', () => {
    expect(clientSalesQuerySchema.parse({})).toEqual({ historyPage: 1, opportunityPage: 1 });
    expect(clientSalesQuerySchema.safeParse({ historyPage: 2 }).success).toBe(false);
    expect(clientSalesQuerySchema.safeParse({ salesGenerationId: id }).success).toBe(false);
    expect(clientSalesQuerySchema.safeParse({ salesGenerationId: id, catalogState: 'available', catalogGenerationId: id,
      asOfDate: '2026-11-03', clientVersion: 1, opportunityPage: '2' }).success).toBe(true);
    expect(clientSalesQuerySchema.safeParse({ salesGenerationId: id, catalogState: 'catalog_unavailable', asOfDate: '2026-11-03',
      clientVersion: 1, historyPage: '2' }).success).toBe(true);
    expect(clientSalesQuerySchema.safeParse({ salesGenerationId: id, asOfDate: '2026-11-03' }).success).toBe(false);
    expect(clientSalesQuerySchema.safeParse({ asOfDate: '2026-11-03' }).success).toBe(false);
    expect(clientSalesQuerySchema.safeParse({ salesGenerationId: id, catalogGenerationId: id,
      asOfDate: '2026-11-03', clientVersion: 1 }).success).toBe(false);
    expect(clientSalesQuerySchema.safeParse({ salesGenerationId: id, catalogState: 'available',
      asOfDate: '2026-11-03', clientVersion: 1 }).success).toBe(false);
    expect(clientSalesQuerySchema.safeParse({ salesGenerationId: id, catalogState: 'catalog_unavailable',
      catalogGenerationId: id, asOfDate: '2026-11-03', clientVersion: 1 }).success).toBe(false);
  });
  it('bounds batches, rejects duplicate IDs and unknown input fields', () => {
    const base = { sellerId: id, serviceDate: '2026-11-03', clientIds: [id] };
    expect(salesSignalsQuerySchema.safeParse(base).success).toBe(true);
    for (const clientIds of [[], [id, id], Array(51).fill(id)]) expect(salesSignalsQuerySchema.safeParse({ ...base, clientIds }).success).toBe(false);
    expect(salesSignalsQuerySchema.safeParse({ ...base, document: 'sensitive' }).success).toBe(false);
    expect(salesSignalsQuerySchema.safeParse({ ...base, serviceDate: '2026-02-30' }).success).toBe(false);
  });
});
