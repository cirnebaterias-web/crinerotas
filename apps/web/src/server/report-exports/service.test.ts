import { describe, expect, it, vi } from 'vitest';
import { collectPaginatedReport } from './service';

const columns = [{ key: 'value', header: 'Valor' }];

describe('paginated report collection', () => {
  it('loads every server page and preserves order', async () => {
    const load = vi.fn(async (cursor: string | undefined) => cursor
      ? { nextCursor: null, values: ['segunda'] }
      : { nextCursor: 'cursor_123', values: ['primeira'] });
    const report = await collectPaginatedReport(load, (page) => ({
      sheetName: 'Página', columns, rows: page.values.map((value) => ({ value })),
    }));
    expect(load).toHaveBeenNthCalledWith(1, undefined);
    expect(load).toHaveBeenNthCalledWith(2, 'cursor_123');
    expect(report.rows).toEqual([{ value: 'primeira' }, { value: 'segunda' }]);
  });

  it('fails closed when the cursor repeats', async () => {
    await expect(collectPaginatedReport(
      async () => ({ nextCursor: 'cursor_123', values: ['linha'] }),
      (page) => ({ sheetName: 'Página', columns, rows: page.values.map((value) => ({ value })) }),
    )).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
  });
});
