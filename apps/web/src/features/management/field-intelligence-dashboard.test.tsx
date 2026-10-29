import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { FieldIntelligenceResponse } from '@cirne/contracts';
import { FieldIntelligenceDashboard } from './field-intelligence-dashboard';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('../scrap/scrap-ui', () => ({ ScrapShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

const stockResult: FieldIntelligenceResponse = {
  schemaVersion: 1,
  section: 'stock',
  filters: { section: 'stock', from: '2026-10-26', to: '2026-11-01' },
  generatedAt: '2026-10-28T12:00:00.000Z',
  lastConfirmedAt: '2026-10-28T11:55:00.000Z',
  nextCursor: null,
  serverVisibilityNote: 'Somente fatos recebidos e confirmados pelo servidor estão incluídos; conteúdo ainda apenas no aparelho não é conhecido.',
  indicators: { records: 1, heliarQuantity: 2, mouraQuantity: 3, ownLineQuantity: 2, competitorLineQuantity: 1 },
  records: [{
    recordId: '10000000-0000-4000-8000-000000000001',
    visitId: '10000000-0000-4000-8000-000000000002', serviceDate: '2026-10-28',
    seller: { id: '10000000-0000-4000-8000-000000000003', name: 'Vendedor Sintético' },
    client: { id: '10000000-0000-4000-8000-000000000004', name: 'Cliente Visitado' },
    confirmedAt: '2026-10-28T11:55:00.000Z', heliarQuantity: 2, mouraQuantity: 3,
    ownLines: [{ brand: 'Heliar', model: '60 Ah', quantity: 2 }],
    competitorLines: [{ brand: 'Moura', amperage: 60, technology: 'Convencional', quantity: 1 }],
  }],
};

describe('field intelligence dashboard', () => {
  it('renders the five URL-backed recuts, indicators and confirmed record without sensitive payloads', () => {
    const html = renderToStaticMarkup(<FieldIntelligenceDashboard initial={{
      kind: 'ready', filters: stockResult.filters, result: stockResult,
    }} />);
    for (const label of ['Estoque', 'Preços', 'Ações', 'Sucata', 'Resultados']) expect(html).toContain(label);
    expect(html).toContain('Cliente Visitado');
    expect(html).toContain('Vendedor Sintético');
    expect(html).toContain('Heliar · 60 Ah · 2 unidade(s)');
    expect(html).toContain('Moura · 60 Ah · Convencional · 1 unidade(s)');
    expect(html).not.toContain('Kg coletados');
    expect(html).not.toContain('latitude');
    expect(html).not.toContain('storagePath');
    expect(html).not.toContain('idempotency');
  });

  it('renders forbidden without operational indicators or cards', () => {
    const html = renderToStaticMarkup(<FieldIntelligenceDashboard initial={{
      kind: 'forbidden', filters: stockResult.filters, message: 'Seu perfil não tem acesso à Inteligência de Campo.',
    }} />);
    expect(html).toContain('Acesso não autorizado');
    expect(html).not.toContain('Cliente Visitado');
    expect(html).not.toContain('Indicadores do recorte');
  });

  it('formats confirmation timestamps in the explicit operational time zone', () => {
    const results: FieldIntelligenceResponse = {
      schemaVersion: 1,
      section: 'results',
      filters: { section: 'results', from: '2026-10-26', to: '2026-11-01' },
      generatedAt: '2026-10-28T12:00:00.000Z',
      lastConfirmedAt: '2026-10-28T11:55:00.000Z',
      nextCursor: null,
      serverVisibilityNote: stockResult.serverVisibilityNote,
      indicators: { records: 1, completedVisits: 1 },
      records: [{
        recordId: '30000000-0000-4000-8000-000000000001',
        visitId: '30000000-0000-4000-8000-000000000002',
        serviceDate: '2026-10-28',
        seller: { id: '30000000-0000-4000-8000-000000000003', name: 'Vendedor Sintético' },
        client: { id: '30000000-0000-4000-8000-000000000004', name: 'Cliente Visitado' },
        confirmedAt: '2026-10-28T11:55:00.000Z',
        outcome: 'completed',
        deviceStartedAt: '2026-10-28T11:00:00.000Z',
        serverStartedAt: '2026-10-28T11:00:01.000Z',
        deviceCompletedAt: '2026-10-28T11:54:59.000Z',
        serverCompletedAt: '2026-10-28T11:55:00.000Z',
      }],
    };
    const html = renderToStaticMarkup(<FieldIntelligenceDashboard
      initial={{ kind: 'ready', filters: results.filters, result: results }}
      timeZone="America/Sao_Paulo"
    />);
    expect(html.match(/28\/10\/2026, 08:55/g)).toHaveLength(2);
    expect(html).not.toContain('28/10/2026, 11:55');
  });

  it('renders historical price attributes and the recorded label for an other action', () => {
    const common = {
      recordId: '20000000-0000-4000-8000-000000000001',
      visitId: '20000000-0000-4000-8000-000000000002',
      serviceDate: '2026-10-28',
      seller: { id: '20000000-0000-4000-8000-000000000003', name: 'Vendedor Sintético' },
      client: { id: '20000000-0000-4000-8000-000000000004', name: 'Cliente Visitado' },
      confirmedAt: '2026-10-28T11:55:00.000Z',
    };
    const prices: FieldIntelligenceResponse = {
      schemaVersion: 1, section: 'prices', filters: { section: 'prices', from: '2026-10-26', to: '2026-11-01' },
      generatedAt: '2026-10-28T12:00:00.000Z', lastConfirmedAt: common.confirmedAt, nextCursor: null,
      serverVisibilityNote: stockResult.serverVisibilityNote,
      indicators: { records: 1, quotations: 1, unavailableRecords: 0 },
      records: [{ ...common, availability: 'available', unavailableReason: null, quotations: [{
        id: '20000000-0000-4000-8000-000000000005',
        competitor: { id: '20000000-0000-4000-8000-000000000006', label: 'Concorrente A' },
        modelOrAmperage: '60 Ah', technology: { id: '20000000-0000-4000-8000-000000000007', label: 'AGM' },
        priceBrl: '499.90', condition: { id: '20000000-0000-4000-8000-000000000008', label: 'À vista' },
        observation: 'Entrega inclusa',
      }] }],
    };
    const actions: FieldIntelligenceResponse = {
      schemaVersion: 1, section: 'actions', filters: { section: 'actions', from: '2026-10-26', to: '2026-11-01' },
      generatedAt: '2026-10-28T12:00:00.000Z', lastConfirmedAt: common.confirmedAt, nextCursor: null,
      serverVisibilityNote: stockResult.serverVisibilityNote,
      indicators: { records: 1, identifiedRecords: 1, actions: 1 },
      records: [{ ...common, availability: 'identified', actions: [{
        id: '20000000-0000-4000-8000-000000000009',
        competitor: { id: '20000000-0000-4000-8000-000000000006', label: 'Concorrente A' },
        actionType: 'other', otherType: 'Feirão local', description: 'Ação histórica',
        validFrom: '2026-10-28', validUntil: '2026-10-31',
      }] }],
    };

    const priceHtml = renderToStaticMarkup(<FieldIntelligenceDashboard initial={{ kind: 'ready', filters: prices.filters, result: prices }} />);
    expect(priceHtml).toContain('AGM · R$ 499.90');
    expect(priceHtml).toContain('Condição: À vista · Entrega inclusa');
    const actionHtml = renderToStaticMarkup(<FieldIntelligenceDashboard initial={{ kind: 'ready', filters: actions.filters, result: actions }} />);
    expect(actionHtml).toContain('Concorrente A · Feirão local');
    expect(actionHtml).toContain('Ação histórica');
  });
});
