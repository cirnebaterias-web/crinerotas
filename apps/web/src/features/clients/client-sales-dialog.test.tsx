import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ClientSalesContent, SalesMetricsView } from './client-sales-dialog';
import { syntheticClientSales } from './client-sales-fixture';

describe('client sales presentation', () => {
  it('exposes signed chart values in a table and labels exact windows, coverage and partial month', () => {
    const html = renderToStaticMarkup(<ClientSalesContent data={syntheticClientSales()} busy={false} onPage={() => undefined} />);
    expect(html).toContain('<caption>Valores do gráfico em unidades</caption>');
    expect(html).toContain('<td>-5</td>');
    expect(html).toContain('is-negative');
    expect(html).toContain('Sem registros observados');
    expect(html).toContain('01/05/2026');
    expect(html).toContain('31/10/2026');
    expect(html).toContain('Mês atual: Parcial');
    expect(html).toContain('não comprova completude');
    expect(html).toContain('Produtos sem compra registrada no histórico disponível');
    expect(html).toContain('Catálogo oficial com 157 produtos');
    expect(html).toContain('versão 70000000');
    expect(html).toContain('Produto exclusivo do catálogo oficial');
    expect(html).not.toContain('499,90');
    expect(html).toContain('Devolução');
    expect(html).not.toContain('3198');
  });
  it('distinguishes no purchase and insufficient history from numeric zero', () => {
    const metrics = { ...syntheticClientSales().metrics, lastPurchaseDate: null, daysSinceLastPurchase: null,
      periodicityDays: null, positivePurchaseDateCount: 0, intervalCount: 0 };
    const html = renderToStaticMarkup(<SalesMetricsView metrics={metrics} />);
    expect(html).toContain('Sem compra no histórico disponível');
    expect(html).toContain('Histórico insuficiente');
    expect(html).not.toContain('0 dias');
  });
  it('marks missing history and stale capture independently', () => {
    const data = { ...syntheticClientSales(), stale: true, dataState: 'no_history' as const };
    const html = renderToStaticMarkup(<ClientSalesContent data={data} busy={false} onPage={() => undefined} />);
    expect(html).toContain('Sem histórico disponível para este cliente');
    expect(html).toContain('Última captura antiga');
  });
  it('keeps sales visible while opportunities are unavailable without an official catalog', () => {
    const baseline = syntheticClientSales();
    const data = { ...baseline, catalog: { status: 'catalog_unavailable' as const },
      topProducts: baseline.topProducts.map((product) => ({ ...product,
        catalogMatch: 'catalog_missing' as const, catalogItem: null })),
      opportunities: { availability: 'catalog_unavailable' as const } };
    const html = renderToStaticMarkup(<ClientSalesContent data={data} busy={false} onPage={() => undefined} />);
    expect(html).toContain('Catálogo oficial ainda não disponibilizado');
    expect(html).toContain('Catálogo indisponível; dados de Vendas preservados.');
    expect(html).not.toContain('Cadastro pendente no catálogo oficial');
    expect(html).toContain('Histórico de compras');
    expect(html).not.toContain('Nenhum produto nesta consulta');
  });
  it('distinguishes a missing catalog match from zero opportunities in an available catalog', () => {
    const baseline = syntheticClientSales();
    const data = { ...baseline,
      topProducts: baseline.topProducts.map((product) => ({ ...product,
        catalogMatch: 'catalog_missing' as const, catalogItem: null })),
      opportunities: { ...baseline.opportunities, totalCount: 0, products: [] } };
    const html = renderToStaticMarkup(<ClientSalesContent data={data} busy={false} onPage={() => undefined} />);
    expect(html).toContain('Cadastro pendente no catálogo oficial; dados preservados de Vendas.');
    expect(html).toContain('Nenhum produto nesta consulta.');
    expect(html).not.toContain('Catálogo oficial ainda não disponibilizado');
  });
});
