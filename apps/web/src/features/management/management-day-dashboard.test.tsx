import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ManagementDayResponse } from '@cirne/contracts';
import { ManagementDayDashboard } from './management-day-dashboard';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const result: ManagementDayResponse = {
  schemaVersion: 2, serviceDate: '2026-10-20', generatedAt: '2026-10-20T12:00:00.000Z',
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
    nonVisits: [], historicalExecutions: [], syncIssues: [], visits: [],
    lastKnownUpdateAt: '2026-10-20T11:05:00.000Z',
    stops: [{
      routeVersionStopId: '30000000-0000-4000-8000-000000000001', plannedOrder: 1,
      executionOrder: 1, priority: 0,
      client: { id: '40000000-0000-4000-8000-000000000001', name: 'Cliente Visitado' },
      status: 'completed', nonVisitReason: null, lastKnownUpdateAt: '2026-10-20T11:05:00.000Z',
      visits: [{
        visitId: '50000000-0000-4000-8000-000000000001',
        routeVersionStopId: '30000000-0000-4000-8000-000000000001',
        client: { id: '40000000-0000-4000-8000-000000000001', name: 'Cliente Visitado' },
        status: 'completed', deviceStartedAt: '2026-10-20T10:00:00.000Z',
        serverStartedAt: '2026-10-20T10:00:01.000Z', lastKnownUpdateAt: '2026-10-20T11:05:00.000Z',
        exceptionCount: 0,
        checklist: { facadeCheckin: 'confirmed', checkout: 'confirmed', stock: 'confirmed',
          competitorPrices: 'confirmed', commercialActions: 'confirmed', scrap: 'confirmed',
          result: 'confirmed', synchronization: 'confirmed' },
      }],
    }, {
      routeVersionStopId: '30000000-0000-4000-8000-000000000002', plannedOrder: 2,
      executionOrder: 2, priority: 0,
      client: { id: '40000000-0000-4000-8000-000000000002', name: 'Cliente Pendente' },
      status: 'pending', nonVisitReason: null, lastKnownUpdateAt: '2026-10-20T11:05:00.000Z', visits: [],
    }],
  }],
};

describe('management day dashboard', () => {
  it('renders the desktop route table and the sanitized stop inspector', () => {
    const html = renderToStaticMarkup(<ManagementDayDashboard
      initial={{ kind: 'ready', serviceDate: result.serviceDate, result }} canPlanRoutes />);
    expect(html).toContain('Vendedor Sintético');
    expect(html).toContain('Cliente Visitado');
    expect(html).toContain('Situação das atividades no servidor');
    expect(html).toContain('Foto da fachada / check-in');
    expect(html).toContain('Abrir detalhe completo');
    expect(html).toContain('Requer atenção');
    expect(html).toContain('1 envio pendente');
    expect(html).toContain('itens ainda apenas no aparelho não são visíveis');
    expect(html).toContain('Mapa de apoio');
    expect(html).toContain('Mostrar mapa');
    expect(html).toContain('Criar ou editar rota do dia');
    expect(html).toContain('/management/routes?serviceDate=2026-10-20');
    expect(html).not.toContain('latitude');
    expect(html).not.toContain('photoUrl');
    expect(html).not.toContain('payload');
  });

  it('makes multiple visits to the same stop explicit', () => {
    const multiple = structuredClone(result);
    if (multiple.schemaVersion !== 2) throw new Error('Fixture v2 esperada.');
    const firstVisit = multiple.routes[0]!.stops[0]!.visits[0]!;
    multiple.routes[0]!.stops[0]!.visits.push({
      ...firstVisit,
      visitId: '50000000-0000-4000-8000-000000000002',
      serverStartedAt: '2026-10-20T12:00:01.000Z',
    });
    const html = renderToStaticMarkup(<ManagementDayDashboard initial={{ kind: 'ready', serviceDate: multiple.serviceDate, result: multiple }} />);
    expect(html).toContain('2 visitas registradas');
    expect(html).toContain('Visita 1');
    expect(html).toContain('Visita 2');
  });

  it('renders forbidden without operational data', () => {
    const html = renderToStaticMarkup(<ManagementDayDashboard initial={{ kind: 'forbidden', serviceDate: '2026-10-20', message: 'Seu perfil não tem acesso à visão gerencial.' }} />);
    expect(html).toContain('Acesso não autorizado');
    expect(html).not.toContain('Indicadores do dia');
  });

  it('does not expose the planning action without the scoped capability', () => {
    const html = renderToStaticMarkup(<ManagementDayDashboard
      initial={{ kind: 'ready', serviceDate: result.serviceDate, result }} />);
    expect(html).not.toContain('Criar ou editar rota do dia');
  });
});
