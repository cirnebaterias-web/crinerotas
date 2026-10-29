import { describe, expect, it } from 'vitest';
import { reportExportQuerySchema } from './report-exports';

describe('report export contracts', () => {
  it('accepts only the fixed filters of each canonical view', () => {
    expect(reportExportQuerySchema.parse({
      view: 'management_day', format: 'csv', serviceDate: '2026-10-29',
    })).toEqual({ view: 'management_day', format: 'csv', serviceDate: '2026-10-29' });
    expect(reportExportQuerySchema.safeParse({
      view: 'management_day', format: 'csv', serviceDate: '2026-10-29', sort: 'seller',
    }).success).toBe(false);
    expect(reportExportQuerySchema.safeParse({
      view: 'pilot_metrics', format: 'pdf', from: '2026-10-01', to: '2026-10-29',
    }).success).toBe(false);
  });

  it('preserves section-specific intelligence validation', () => {
    expect(reportExportQuerySchema.safeParse({
      view: 'field_intelligence', format: 'xlsx', section: 'stock',
      from: '2026-10-01', to: '2026-10-29', actionType: 'other',
    }).success).toBe(false);
    expect(reportExportQuerySchema.safeParse({
      view: 'field_intelligence', format: 'xlsx', section: 'actions',
      from: '2026-10-01', to: '2026-10-29', actionType: 'other',
    }).success).toBe(true);
  });

  it('rejects inverted periods', () => {
    expect(reportExportQuerySchema.safeParse({
      view: 'scrap_agenda', format: 'csv', from: '2026-10-30', to: '2026-10-29', status: 'pending',
    }).success).toBe(false);
  });
});
