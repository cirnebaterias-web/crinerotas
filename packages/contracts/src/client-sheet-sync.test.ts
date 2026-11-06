import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { clientSheetScheduledSlot, clientSheetSyncRequestSchema } from './client-sheet-sync';
describe('Google sheet schedule', () => {
  it.each([
    ['2026-11-03T08:59:59Z', null], ['2026-11-03T09:00:00Z', '2026-11-03@06:00'],
    ['2026-11-03T09:59:59Z', '2026-11-03@06:00'], ['2026-11-03T10:00:00Z', null],
    ['2026-11-03T16:00:00Z', '2026-11-03@13:00'], ['2026-11-04T01:00:00Z', null],
    ['2026-12-31T16:00:00Z', '2026-12-31@13:00'], ['2027-01-01T09:00:00Z', '2027-01-01@06:00'],
  ])('resolves %s in São Paulo independently of host timezone', (date, slot) => {
    expect(clientSheetScheduledSlot(new Date(date))).toBe(slot);
  });
  it('has exactly two timezone-specific host timer entries, no startup catchup', () => {
    const timer = readFileSync('infrastructure/systemd/cirne-client-sync.timer', 'utf8');
    expect(timer.split('\n').filter((line) => line.startsWith('OnCalendar='))).toEqual([
      'OnCalendar=*-*-* 06:00:00 America/Sao_Paulo', 'OnCalendar=*-*-* 13:00:00 America/Sao_Paulo',
    ]);
    expect(timer).toContain('Persistent=false');
  });
  it('does not accept a caller-selected scheduled slot or arbitrary URL', () => {
    expect(clientSheetSyncRequestSchema.safeParse({ trigger: 'scheduled', slot: 'tomorrow' }).success).toBe(false);
    expect(clientSheetSyncRequestSchema.safeParse({ trigger: 'manual', url: 'https://example.test' }).success).toBe(false);
  });
  it('canonicalizes the UUID so uppercase and lowercase retries are the same intent', () => {
    expect(clientSheetSyncRequestSchema.parse({ trigger: 'manual',
      idempotencyKey: 'ABCDEF00-0000-4000-8000-000000000001' })).toEqual({ trigger: 'manual',
      idempotencyKey: 'abcdef00-0000-4000-8000-000000000001' });
  });
});
