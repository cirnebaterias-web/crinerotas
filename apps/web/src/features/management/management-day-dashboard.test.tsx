import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ManagementDayResponse } from '@cirne/contracts';
import { ManagementDayDashboard } from './management-day-dashboard';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('../scrap/scrap-ui', () => ({ ScrapShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

const result: ManagementDayResponse = {
  schemaVersion: 1, serviceDate: '2026-10-20', generatedAt: '2026-10-20T12:00:00.000Z',
  lastKnownUpdateAt: '2026-10-20T11:05:00.000Z', availability: 'available',
  totals: { planned: 2, pending: 1, inVisit: 0, completed: 1, notVisited: 0 },
  sync: { pending: 1, errors: 0, oldestPendingAt: '2026-10-20T11:00:00.000Z', lastKnownAt: '2026-10-20T11:05:00.000Z' },
  serverVisibilityNote: 'Somente eventos recebidos pelo servidor estão incluídos; itens ainda apenas no aparelho não são visíveis.',
  routes: [{
    routeId: '10000000-0000-4000-8000-000000000001',
    routeVersionId: '10000000-0000-4000-8000-000000000002', versionNumber: 2,
    seller: { id: '20000000-0000-4000-8000-000000000001', displayName: 'Vendedor Sintético' },
    counts: { planned: 2, pending: 1, inVisit: 0, completed: 1, notVisited: 0 },
    sync: { pending: 1, errors: 0, oldestPendingAt: '2026-10-20T11:00:00.000Z', lastKnownAt: '2026-10-20T11:05:00.000Z' },
    nonVisits: [],
    historicalExecutions: [{ routeVersionStopId: '30000000-0000-4000-8000-000000000001',
      clientId: '40000000-0000-4000-8000-000000000001', clientName: 'Cliente Removido',
      status: 'completed', updatedAt: '2026-10-20T10:00:00.000Z' }],
    syncIssues: [{ eventId: '50000000-0000-4000-8000-000000000001', status: 'recoverable_error',
      errorCode: 'DEPENDENCY_UNAVAILABLE', occurredAt: '2026-10-20T11:00:00.000Z',
      lastObservedAt: '2026-10-20T11:05:00.000Z' }],
    visits: [],
    lastKnownUpdateAt: '2026-10-20T11:05:00.000Z',
  }],
};

describe('management day dashboard', () => {
  it('renders indicators, textual statuses, historical exceptions and the server visibility limit', () => {
    const html = renderToStaticMarkup(<ManagementDayDashboard initial={{ kind: 'ready', serviceDate: result.serviceDate, result }} />);
    expect(html).toContain('Vendedor Sintético');
    expect(html).toContain('Cliente Removido');
    expect(html).toContain('Recuperável');
    expect(html).toContain('DEPENDENCY_UNAVAILABLE');
    expect(html).toContain('itens ainda apenas no aparelho não são visíveis');
    expect(html).not.toContain('latitude');
    expect(html).not.toContain('payload');
  });

  it('renders forbidden without operational data', () => {
    const html = renderToStaticMarkup(<ManagementDayDashboard initial={{ kind: 'forbidden',
      serviceDate: '2026-10-20', message: 'Seu perfil não tem acesso à visão gerencial.' }} />);
    expect(html).toContain('Acesso não autorizado');
    expect(html).not.toContain('Indicadores do dia');
  });
});
