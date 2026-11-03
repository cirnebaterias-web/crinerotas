import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ReportExportActions } from './report-export-actions';

it('renders secondary CSV and XLSX actions without a new navigation destination', () => {
  const html = renderToStaticMarkup(<ReportExportActions
    view="field_intelligence"
    filters={{ section: 'stock', from: '2026-10-20', to: '2026-10-29' }}
  />);
  expect(html).toContain('Exportar relatório');
  expect(html).toContain('CSV');
  expect(html).toContain('XLSX');
  expect(html).not.toContain('href=');
});
