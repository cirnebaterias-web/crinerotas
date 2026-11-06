import { describe, expect, it } from 'vitest';
import { assignLogisticsPickupSchema, recordLogisticsPickupSchema, correctLogisticsPickupSchema, reviewLogisticsPickupSchema } from './logistics-pickups';

describe('logistics pickup commands', () => {
  const base = { schemaVersion: 1, expectedVersion: 1 };
  it('allows truthful partial/above outcomes without sending a promised weight', () => {
    for (const actualWeightKg of ['80', '100.00', '120']) {
      expect(recordLogisticsPickupSchema.safeParse({ ...base, outcome: 'collected', actualWeightKg, reason: 'Peso verificado' }).success).toBe(true);
    }
    expect(recordLogisticsPickupSchema.safeParse({ ...base, outcome: 'collected', actualWeightKg: '80', promisedWeightKg: '80' }).success).toBe(false);
  });
  it('rejects false zero collections, nonzero no-collection and missing reasons', () => {
    expect(recordLogisticsPickupSchema.safeParse({ ...base, outcome: 'collected', actualWeightKg: '0.000' }).success).toBe(false);
    expect(recordLogisticsPickupSchema.safeParse({ ...base, outcome: 'not_collected', actualWeightKg: '1', reason: 'Ausente' }).success).toBe(false);
    expect(recordLogisticsPickupSchema.safeParse({ ...base, outcome: 'not_collected', actualWeightKg: '0' }).success).toBe(false);
    expect(recordLogisticsPickupSchema.safeParse({ ...base, outcome: 'not_collected', actualWeightKg: '0.00', reason: 'Cliente ausente' }).success).toBe(true);
  });
  it('requires reasons and valid revisions on assignment, correction and review', () => {
    expect(assignLogisticsPickupSchema.safeParse({ ...base, operatorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', routeDate: '2026-11-04', routeOrder: 1, reason: 'Rota diária' }).success).toBe(true);
    expect(correctLogisticsPickupSchema.safeParse({ ...base, outcome: 'collected', actualWeightKg: '85' }).success).toBe(false);
    expect(reviewLogisticsPickupSchema.safeParse({ ...base, reason: '   ' }).success).toBe(false);
    expect(reviewLogisticsPickupSchema.safeParse({ ...base, expectedVersion: 0, reason: 'Conferido' }).success).toBe(false);
  });
});
