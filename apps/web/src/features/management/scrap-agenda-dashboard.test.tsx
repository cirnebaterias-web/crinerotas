import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ScrapAgendaResponse } from '@cirne/contracts';
import { ScrapAgendaDashboard } from './scrap-agenda-dashboard';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('../scrap/scrap-ui', () => ({ ScrapShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('./pickup-schedule-revision-form', () => ({ PickupScheduleRevisionForm: () => <form>Revisão</form> }));

const result: ScrapAgendaResponse = {
  schemaVersion: 1,
  filters: { from: '2026-10-26', to: '2026-11-01', status: 'pending' },
  generatedAt: '2026-10-28T12:00:00.000Z', lastServerConfirmedAt: '2026-10-28T11:55:00.000Z',
  indicators: { records: 1, scheduledKg: '42.50' }, nextCursor: null,
  serverVisibilityNote: 'Somente agendamentos recebidos e confirmados pelo servidor estão incluídos; conteúdo ainda apenas no aparelho não é conhecido.',
  records: [{
    id: '10000000-0000-4000-8000-000000000001', offlineId: '10000000-0000-4000-8000-000000000002',
    client: { id: '10000000-0000-4000-8000-000000000003', name: 'Cliente agenda', address: 'Endereço preservado' },
    seller: { id: '10000000-0000-4000-8000-000000000004', displayName: 'Vendedor agenda' },
    origin: 'standalone', visitId: null, estimatedWeightKg: '42.50', desiredDate: '2026-10-30',
    period: 'morning', observation: 'Observação histórica', requestedAt: '2026-10-28T10:00:00.000Z',
    serverSavedAt: '2026-10-28T10:00:01.000Z', status: 'pending', version: 2,
  }],
};

describe('scrap agenda dashboard', () => {
  it('renders filters, estimated total and a pending server-confirmed schedule', () => {
    const html = renderToStaticMarkup(<ScrapAgendaDashboard initial={{ kind: 'ready', filters: result.filters, result }} operationalTimeZone="America/Sao_Paulo" />);
    expect(html).toContain('Pendências confirmadas');
    expect(html).toContain('Cliente agenda');
    expect(html).toContain('42.50 kg estimados');
    expect(html).toContain('Estado:</strong> Pendente');
    expect(html).toContain('Revisar agendamento');
    expect(html).toContain('Data desejada inicial');
    expect(html).not.toContain('Kg coletados');
    expect(html).not.toContain('actualWeight');
    expect(html).not.toContain('latitude');
  });

  it('renders forbidden without indicators or records', () => {
    const html = renderToStaticMarkup(<ScrapAgendaDashboard operationalTimeZone="America/Sao_Paulo" initial={{
      kind: 'forbidden', filters: result.filters, message: 'Seu perfil não tem acesso à agenda de sucata.',
    }} />);
    expect(html).toContain('Acesso não autorizado');
    expect(html).not.toContain('Cliente agenda');
    expect(html).not.toContain('Indicadores da agenda');
  });
});
