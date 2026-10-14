import { describe, expect, it, vi } from 'vitest';
import { reviseScrapCollectionRequestSchema, reviseScrapReceiptRequestSchema, scrapCollectionRevisionsSchema } from '@cirne/contracts';
import { requireScrapRevisionAccess, reviseScrapCollection, reviseScrapReceipt } from './revisions';
describe('audited scrap corrections', () => {
  it('requires manager or administrator and an explicit correction capability', () => {
    for (const identity of [
      { roles: ['seller'], capabilities: ['scrap.manage_operations'] },
      { roles: ['logistics'], capabilities: ['scrap.manage_operations'] },
      { roles: ['manager'], capabilities: ['scrap.manage_points', 'scrap.read_operations'] },
    ]) expect(() => requireScrapRevisionAccess(identity as never)).toThrow();
    for (const role of ['manager', 'administrator']) {
      expect(() => requireScrapRevisionAccess({ roles: [role], capabilities: ['scrap.manage_operations'] } as never)).not.toThrow();
    }
  });
  it('requires reason, version and valid destination in collection corrections', () => {
    const valid = { schemaVersion: 1, expectedVersion: 2, reason: 'Corrigir pesagem', actualWeightKg: '100.5',
      collectedAt: '2026-10-06T10:00:00Z', receiptNumber: '001', destinationType: 'headquarters' };
    expect(reviseScrapCollectionRequestSchema.safeParse(valid).success).toBe(true);
    for (const changed of [{ ...valid, reason: '' }, { ...valid, expectedVersion: 0 },
      { ...valid, actualWeightKg: '0' }, { ...valid, destinationType: 'concentration_point' }]) {
      expect(reviseScrapCollectionRequestSchema.safeParse(changed).success).toBe(false);
    }
    expect(reviseScrapReceiptRequestSchema.safeParse({ schemaVersion: 1, expectedVersion: 2,
      reason: 'Conferência revisada', receivedWeightKg: '98', receivedLocation: 'Matriz' }).success).toBe(true);
  });
  it('preserves concurrency conflicts from both correction RPCs', async () => {
    const abortSignal = vi.fn().mockResolvedValue({ data: null, error: { code: 'P0001', message: 'VERSION_CONFLICT' } });
    const rpc = vi.fn<(name: string, args: unknown) => { abortSignal: typeof abortSignal }>(() => ({ abortSignal }));
    const client = { schema: vi.fn(() => ({ rpc })) };
    await expect(reviseScrapCollection(client as never, 'collection', 'key', {} as never)).rejects.toMatchObject({ status: 409 });
    await expect(reviseScrapReceipt(client as never, 'collection', 'key', {} as never)).rejects.toMatchObject({ status: 409 });
    expect(rpc.mock.calls.map((call) => call[0])).toEqual(['revise_scrap_collection', 'revise_scrap_receipt']);
  });
  it('strips private database values from historical snapshots', () => {
    const result = scrapCollectionRevisionsSchema.parse({ schemaVersion: 1, revisions: [{
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', kind: 'collection',
      actor: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', displayName: 'Gestor' }, changedAt: '2026-10-06T10:00:00Z',
      reason: 'Pesagem', before: { actualWeightKg: '100', storage_path: 'private', device_id: 'device' },
      after: { actualWeightKg: '98', checksum: 'secret' },
    }] });
    expect(result.revisions[0]?.before).toEqual({ actualWeightKg: '100' });
    expect(result.revisions[0]?.after).toEqual({ actualWeightKg: '98' });
  });
});
