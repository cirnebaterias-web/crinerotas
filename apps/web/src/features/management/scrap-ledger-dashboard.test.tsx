import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ScrapLedgerDashboard, scrapLedgerColumns } from './scrap-ledger-dashboard';

describe('scrap ledger dashboard', () => {
  it('states the three supported filter fields explicitly', () => {
    const html = renderToStaticMarkup(<ScrapLedgerDashboard />);
    expect(html).toContain('Filtrar por Nome Fantasia, CNPJ ou Razão Social');
    expect(html).not.toContain('Buscar cliente ou documento');
  });

  it('preserves every official column in both analytical views', () => {
    expect(scrapLedgerColumns.entries).toHaveLength(23);
    expect(scrapLedgerColumns.balances).toHaveLength(22);
    expect(scrapLedgerColumns.balances.at(-1)).toBe('trend');
  });
});
