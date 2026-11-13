import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalVisitDraft, StockInput } from '@cirne/contracts';
import { analyzeStockInsights } from '@cirne/domain';
import { StockInsightsBoundary, VisitStockInsightsStep } from './visit-stock-insights-step';

vi.mock('@cirne/domain', async (original) => ({
  ...await original<typeof import('@cirne/domain')>(), analyzeStockInsights: vi.fn(),
}));
const actual = await vi.importActual<typeof import('@cirne/domain')>('@cirne/domain');
const snapshot: StockInput = { heliarQuantity: 0, mouraQuantity: 0, ownLines: [], competitorLines: [] };
function markup(input: StockInput = snapshot) {
  return renderToStaticMarkup(<VisitStockInsightsStep snapshot={input} onEdit={() => {}} onContinue={() => {}} />);
}
afterEach(() => vi.resetAllMocks());

describe('mobile saved stock insights', () => {
  it('presents zero without invented percentages and preserves the two actions', () => {
    vi.mocked(analyzeStockInsights).mockImplementation(actual.analyzeStockInsights);
    const html = markup();
    expect(html).toContain('Participação no estoque observado');
    expect(html).toContain('Sem estoque observado');
    expect(html).not.toContain('0%');
    expect(html.match(/Diferença \(própria/g)).toHaveLength(3);
    expect(html).toContain('Não há dados classificáveis');
    expect(html).toContain('Editar estoque');
    expect(html).toContain('Continuar para fotos');
    expect(html).toContain('Após concorrência, antes das fotos');
  });

  it('explains partial coverage and shows only real catalog models with codes', () => {
    vi.mocked(analyzeStockInsights).mockImplementation(actual.analyzeStockInsights);
    const html = markup({ ...snapshot, ownLines: [{ brand: 'Heliar', model: 'Manual', quantity: 3 }],
      competitorLines: [{ brand: 'Moura', amperage: 60, technology: 'SLI', quantity: 8 }] });
    expect(html).toContain('Cobertura parcial');
    expect(html).toContain('Modelo manual sem código');
    expect(html).toContain('Ausência no recorte observado');
    expect(html).toContain('código');
    expect(html).toContain('não comprova ruptura no PDV');
    expect(html).toContain('confirme aplicação, dimensões, polaridade');
  });

  it('separates legacy aggregates from incomplete totals', () => {
    vi.mocked(analyzeStockInsights).mockImplementation(actual.analyzeStockInsights);
    const html = markup({ heliarQuantity: 20, mouraQuantity: 10 });
    expect(html).toContain('Leitura detalhada insuficiente');
    expect(html).toContain('Agregados legados, separados dos totais');
    expect(html).not.toContain('66,7%');
  });

  it('projects the real saved record without sending commit metadata to the strict domain contract', () => {
    vi.mocked(analyzeStockInsights).mockImplementation(actual.analyzeStockInsights);
    const saved: NonNullable<LocalVisitDraft['stock']> = { ...snapshot,
      eventId: '11111111-1111-4111-8111-111111111111', deviceSavedAt: '2026-11-12T12:00:00Z',
      persistenceState: 'saved_on_device', collectionCompletedAt: undefined };
    expect(markup(saved)).toContain('Sem estoque observado');
    expect(markup(saved)).not.toContain('Análise indisponível');
    expect(vi.mocked(analyzeStockInsights).mock.calls[0]![0].snapshot).not.toHaveProperty('eventId');
  });

  it('contains calculation failure after save without losing editing or photos', () => {
    vi.mocked(analyzeStockInsights).mockImplementation(() => { throw new Error('broken metadata'); });
    const before = structuredClone(snapshot);
    const html = markup();
    expect(html).toContain('Análise indisponível');
    expect(html).toContain('O estoque salvo está preservado');
    expect(html).toContain('Editar estoque');
    expect(html).toContain('Continuar para fotos');
    expect(snapshot).toEqual(before);
  });

  it('isolates render failures in a boundary around the reading only', () => {
    expect(StockInsightsBoundary.getDerivedStateFromError()).toEqual({ failed: true });
    const boundary = new StockInsightsBoundary({ children: <div>reading</div> });
    boundary.state = { failed: true };
    expect(renderToStaticMarkup(boundary.render())).toContain('Análise indisponível');
  });
});
