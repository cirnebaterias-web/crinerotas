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
  sections: { stock: { state: 'absent' }, competitorPrices: { state: 'unknown_to_server' }, commercialActions: { state: 'absent' },
    scrap: { state: 'available', recordedAt: at, availability: 'scheduled', collectedWeightKg: null,
      scheduledWeightKg: '15.500', collection: null, schedule: { id, desiredDate: '2026-10-27', period: 'morning', status: 'pending', observation: null } },
    result: { state: 'available', outcome: 'completed', deviceCompletedAt: at, serverCompletedAt: at } },
  synchronization: { status: 'confirmed', occurredAt: at, receivedAt: at, confirmedAt: at, attemptCount: 1, lastErrorCode: null },
  exceptions: [{ kind: 'gps_unavailable', message: 'A localização não estava disponível; a visita continuou com justificativa.', capturedAt: at }],
  location: { state: 'withheld' }, evidence: { state: 'withheld' }, timeline: [],
};

describe('VisitDetailDashboard', () => {
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
