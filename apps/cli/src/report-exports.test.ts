import { describe, expect, it, vi } from 'vitest';
import type { writeFile } from 'node:fs/promises';
import { downloadReportExport, ReportExportCliError, resolveReportExportQuery } from './report-exports';

describe('report exports CLI', () => {
  it('accepts only the canonical view-specific filters', () => {
    expect(resolveReportExportQuery({
      view: 'management_day', format: 'csv', serviceDate: '2026-10-29',
    })).toMatchObject({ view: 'management_day', format: 'csv' });
    expect(() => resolveReportExportQuery({
      view: 'management_day', format: 'pdf', serviceDate: '2026-10-29',
    })).toThrow(ReportExportCliError);
  });

  it('validates the download before writing to the explicit new path', async () => {
    const write = vi.fn(async () => undefined) as unknown as typeof writeFile;
    const request = vi.fn(async () => new Response(new Uint8Array([0xef, 0xbb, 0xbf, 65, 13, 10]), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="cirne-central-do-dia-2026-10-29.csv"',
        'x-export-row-count': '1',
      },
    }));
    const result = await downloadReportExport({
      baseUrl: 'http://127.0.0.1:3000', token: 'synthetic-token',
      query: { view: 'management_day', format: 'csv', serviceDate: '2026-10-29' },
      outputPath: './report.csv', request, write,
    });
    expect(result).toMatchObject({ rowCount: 1, bytes: 6 });
    expect(write).toHaveBeenCalledWith(expect.stringMatching(/report\.csv$/u), expect.any(Uint8Array), { flag: 'wx' });
  });
});
