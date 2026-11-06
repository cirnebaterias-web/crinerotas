import { describe, expect, it } from 'vitest';
import { salesScheduledSlot, salesSyncRequestSchema, salesMoneySchema, salesSyncPublishRequestSchema,
  clientSalesPageSchema, salesImportRowSchema } from './sales';

describe('sales contracts', () => {
  it('derives one daily slot in Sao Paulo only during the bounded retry window', () => {
    expect(salesScheduledSlot(new Date('2026-11-03T09:14:59Z'))).toBeNull();
    expect(salesScheduledSlot(new Date('2026-11-03T09:15:00Z'))).toBe('2026-11-03@06:15');
    expect(salesScheduledSlot(new Date('2026-11-03T09:59:59Z'))).toBe('2026-11-03@06:15');
    expect(salesScheduledSlot(new Date('2026-11-03T10:00:00Z'))).toBeNull();
    expect(salesScheduledSlot(new Date('2026-11-03T16:00:00Z'))).toBeNull();
    expect(salesScheduledSlot(new Date('invalid'))).toBeNull();
  });
  it('rejects arbitrary sources, explicit slots, or absent manual intention', () => {
    expect(salesSyncRequestSchema.safeParse({ trigger: 'scheduled' }).success).toBe(true);
    expect(salesSyncRequestSchema.safeParse({ trigger: 'scheduled', source: 'other' }).success).toBe(false);
    expect(salesSyncRequestSchema.safeParse({ trigger: 'scheduled', slot: 'yesterday' }).success).toBe(false);
    expect(salesSyncRequestSchema.safeParse({ trigger: 'manual' }).success).toBe(false);
  });
  it('never coerces money into a float or allows negative zero', () => {
    expect(salesMoneySchema.parse('-3198.00')).toBe('-3198.00');
    expect(salesMoneySchema.safeParse(3198).success).toBe(false);
    expect(salesMoneySchema.safeParse('-0.00').success).toBe(false);
  });
  it('denies empty publication and unversioned or unsupported parsers', () => {
    const command = { leaseToken: '11111111-1111-4111-8111-111111111111', contentHash: 'a'.repeat(64), expectedRowCount: 1, parserVersion: 1 };
    expect(salesSyncPublishRequestSchema.safeParse(command).success).toBe(true);
    expect(salesSyncPublishRequestSchema.safeParse({ ...command, expectedRowCount: 0 }).success).toBe(false);
    expect(salesSyncPublishRequestSchema.safeParse({ ...command, parserVersion: 2 }).success).toBe(false);
  });
  it('forbids non-projected fields in both import and read models', () => {
    expect(salesImportRowSchema.safeParse({ cost: '12.00' }).success).toBe(false);
    expect(clientSalesPageSchema.safeParse({ costs: [], rows: [] }).success).toBe(false);
  });
});
