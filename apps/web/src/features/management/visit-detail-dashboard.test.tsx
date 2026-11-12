import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { VisitDetailResponse } from '@cirne/contracts';
import { VisitDetailDashboard } from './visit-detail-dashboard';

vi.mock('../scrap/scrap-ui', () => ({ ScrapShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

const id = '11111111-1111-4111-8111-111111111111';
const at = '2026-10-26T12:00:00.000Z';
const detail: VisitDetailResponse = {
  schemaVersion: 1, visitId: id,
  context: { serviceDate: '2026-10-26', route: { id, versionId: id, versionNumber: 2 },
    stop: { id, plannedOrder: 3, priority: 1 }, client: { id, externalReference: null, name: 'Cliente A', address: 'Rua A' },
    seller: { id, displayName: 'Vendedor A' }, parameterSet: { id, version: 1 } },
  status: 'completed', deviceStartedAt: at, serverStartedAt: at, deviceCompletedAt: at,
  serverCompletedAt: at, lastKnownUpdateAt: at,
  serverVisibilityNote: 'Somente dados recebidos e confirmados pelo servidor estão presentes; conteúdo ainda apenas no aparelho não é conhecido.',
  sections: { sales: { state: 'absent' }, stock: { state: 'absent' }, competitorPrices: { state: 'unknown_to_server' }, commercialActions: { state: 'absent' },
    scrap: { state: 'available', recordedAt: at, availability: 'scheduled', collectedWeightKg: null,
      scheduledWeightKg: '15.500', collection: null, schedule: { id, desiredDate: '2026-10-27', period: 'morning', status: 'pending', observation: null } },
    result: { state: 'available', outcome: 'completed', deviceCompletedAt: at, serverCompletedAt: at } },
  synchronization: { status: 'confirmed', occurredAt: at, receivedAt: at, confirmedAt: at, attemptCount: 1, lastErrorCode: null },
  exceptions: [{ kind: 'gps_unavailable', message: 'A localização não estava disponível; a visita continuou com justificativa.', capturedAt: at }],
  location: { state: 'withheld' }, evidence: { state: 'withheld' }, timeline: [],
};

describe('VisitDetailDashboard', () => {
  it('renders the three declared quantities including explicit zero in their own visit section', () => {
    const result: VisitDetailResponse = { ...detail, sections: { ...detail.sections, sales: {
      state: 'available', recordedAt: at, heliarQuantity: 0, americaQuantity: 3, stradaDurexQuantity: 8,
    } } };
    const html = renderToStaticMarkup(<VisitDetailDashboard initial={{ kind: 'ready', result }} />);
    expect(html).toContain('Declaração de venda na visita');
    expect(html).toContain('<dt>Heliar</dt><dd>0</dd>');
    expect(html).toContain('<dt>América</dt><dd>3</dd>');
    expect(html).toContain('<dt>Strada/Durex</dt><dd>8</dd>');
  });

  it.each([['absent', 'Não informado'], ['unknown_to_server', 'Não conhecido pelo servidor']] as const)(
    'renders %s sales as text without manufactured zero quantities', (state, label) => {
      const result: VisitDetailResponse = { ...detail, sections: { ...detail.sections, sales: { state } } };
      const html = renderToStaticMarkup(<VisitDetailDashboard initial={{ kind: 'ready', result }} />);
      const section = html.split('id="visit-sales-title"')[1]!.split('</section>')[0]!;
      expect(section).toContain(label);
      expect(section).not.toContain('<dd>');
    },
  );
  it('shows historical source and observed GPS separately only when authorized', () => {
    const result: VisitDetailResponse = { ...detail,
      context: { ...detail.context, client: { ...detail.context.client,
        googleLocation: { address: 'Endereço Google histórico', placeId: 'EjR_123', status: 'REVISAR', precision: 'RANGE_INTERPOLATED' } } },
      location: { state: 'available', latitude: '-5.12345', longitude: '-35.12345', accuracyM: '15', distanceM: '220', capturedAt: at },
    };
    const html = renderToStaticMarkup(<VisitDetailDashboard initial={{ kind: 'ready', result }} />);
    expect(html).toContain('Endereço Google histórico');
    expect(html).toContain('GPS observado nesta visita');
    expect(html).toContain('Capturado em');
    expect(html).toContain('-5.12345');
    expect(html).toContain('não comprova falha do vendedor');
    const redacted = renderToStaticMarkup(<VisitDetailDashboard initial={{ kind: 'ready', result: { ...result, location: { state: 'withheld' } } }} />);
    expect(redacted).not.toContain('-5.12345');
    expect(redacted).not.toContain('GPS observado nesta visita');
  });
  it('renders historical context, distinct scrap totals and explicit redaction states', () => {
    const html = renderToStaticMarkup(<VisitDetailDashboard initial={{ kind: 'ready', result: detail }} />);
    expect(html).toContain('Cliente A');
    expect(html).toContain('Versão 2, parada 3');
    expect(html).toContain('Kg coletados');
    expect(html).toContain('15.500');
    expect(html).toContain('Confirmada');
    expect(html).toContain('Oculto por permissão');
    expect(html).toContain('Não conhecido pelo servidor');
    expect(html).not.toContain('storagePath');
    expect(html).not.toContain('signedUrl');
  });

  it('does not render operational content for a forbidden state', () => {
    const html = renderToStaticMarkup(<VisitDetailDashboard initial={{ kind: 'forbidden', visitId: id, message: 'Indisponível.' }} />);
    expect(html).toContain('Visita indisponível');
    expect(html).not.toContain('Contexto preservado');
  });
});
