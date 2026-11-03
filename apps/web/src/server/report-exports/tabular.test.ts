import { describe, expect, it } from 'vitest';
import type { FieldIntelligenceResponse, ManagementDayResponse, ScrapAgendaResponse } from '@cirne/contracts';
import { fieldIntelligenceReport, managementDayReport, scrapAgendaReport } from './tabular';

const common = {
  recordId: '10000000-0000-4000-8000-000000000001',
  visitId: '10000000-0000-4000-8000-000000000002', serviceDate: '2026-10-29',
  seller: { id: '10000000-0000-4000-8000-000000000003', name: 'Vendedor' },
  client: { id: '10000000-0000-4000-8000-000000000004', name: 'Cliente' },
  confirmedAt: '2026-10-29T12:00:00.000Z',
};

describe('authorized tabular projections', () => {
  it('preserves the dashboard wording for activities still in progress', () => {
    const visit = {
      visitId: common.visitId, routeVersionStopId: '10000000-0000-4000-8000-000000000010',
      client: { id: common.client.id, name: 'Cliente' }, status: 'in_progress' as const,
      deviceStartedAt: '2026-10-29T11:00:00.000Z', serverStartedAt: '2026-10-29T11:00:01.000Z',
      lastKnownUpdateAt: '2026-10-29T12:00:00.000Z', exceptionCount: 0,
      checklist: { facadeCheckin: 'confirmed', checkout: 'not_occurred', stock: 'unknown_to_server',
        competitorPrices: 'withheld', commercialActions: 'not_occurred', scrap: 'not_occurred',
        result: 'not_occurred', synchronization: 'confirmed' } as const,
    };
    const response: ManagementDayResponse = {
      schemaVersion: 2, serviceDate: '2026-10-29', generatedAt: '2026-10-29T12:00:00.000Z',
      lastKnownUpdateAt: '2026-10-29T12:00:00.000Z', availability: 'available',
      totals: { planned: 1, pending: 0, inVisit: 1, completed: 0, notVisited: 0 },
      sync: { pending: 0, errors: 0, oldestPendingAt: null, lastKnownAt: '2026-10-29T12:00:00.000Z' },
      serverVisibilityNote: 'Somente eventos recebidos pelo servidor estão incluídos; itens ainda apenas no aparelho não são visíveis.',
      routes: [{ routeId: '10000000-0000-4000-8000-000000000011', routeVersionId: '10000000-0000-4000-8000-000000000012',
        versionNumber: 1, seller: { id: common.seller.id, displayName: 'Vendedor' },
        counts: { planned: 1, pending: 0, inVisit: 1, completed: 0, notVisited: 0 },
        sync: { pending: 0, errors: 0, oldestPendingAt: null, lastKnownAt: '2026-10-29T12:00:00.000Z' },
        nonVisits: [], historicalExecutions: [], syncIssues: [], visits: [visit],
        lastKnownUpdateAt: '2026-10-29T12:00:00.000Z',
        stops: [{ routeVersionStopId: visit.routeVersionStopId, plannedOrder: 1, executionOrder: 1, priority: 0,
          client: visit.client, status: 'in_visit', nonVisitReason: null,
          lastKnownUpdateAt: '2026-10-29T12:00:00.000Z', visits: [visit] }] }],
    };
    expect(managementDayReport(response).rows[0]).toMatchObject({
      checkout: 'Ainda não ocorreu', stock: 'Ainda não recebido', prices: 'Acesso restrito',
    });
  });

  it('keeps collected and scheduled scrap weights in distinct columns', () => {
    const response: FieldIntelligenceResponse = {
      schemaVersion: 1, section: 'scrap', filters: { section: 'scrap', from: '2026-10-29', to: '2026-10-29' },
      generatedAt: '2026-10-29T12:00:00.000Z', lastConfirmedAt: '2026-10-29T12:00:00.000Z', nextCursor: null,
      serverVisibilityNote: 'Somente fatos recebidos e confirmados pelo servidor estão incluídos; conteúdo ainda apenas no aparelho não é conhecido.',
      indicators: { records: 2, collectedRecords: 1, scheduledRecords: 1, collectedWeightKg: '25', scheduledWeightKg: '40' },
      records: [
        { ...common, availability: 'collected', collection: { id: '10000000-0000-4000-8000-000000000005', actualWeightKg: '25', collectedAt: '2026-10-29T12:00:00.000Z' }, schedule: null },
        { ...common, recordId: '10000000-0000-4000-8000-000000000006', availability: 'scheduled', collection: null,
          schedule: { id: '10000000-0000-4000-8000-000000000007', estimatedWeightKg: '40', desiredDate: '2026-10-30', period: 'morning', status: 'pending' } },
      ],
    };
    const report = fieldIntelligenceReport(response);
    expect(report.columns.map(({ header }) => header)).toEqual(expect.arrayContaining([
      'Peso real coletado (kg)', 'Peso estimado agendado (kg)',
    ]));
    expect(report.rows[0]).toMatchObject({ actualWeight: '25', estimatedWeight: null });
    expect(report.rows[1]).toMatchObject({ actualWeight: null, estimatedWeight: '40' });
  });

  it('exports the agenda without technical identifiers or observations', () => {
    const response: ScrapAgendaResponse = {
      schemaVersion: 1, filters: { from: '2026-10-29', to: '2026-10-30', status: 'pending' },
      generatedAt: '2026-10-29T12:00:00.000Z', lastServerConfirmedAt: '2026-10-29T12:00:00.000Z',
      indicators: { records: 1, scheduledKg: '40' }, nextCursor: null,
      serverVisibilityNote: 'Somente agendamentos recebidos e confirmados pelo servidor estão incluídos; conteúdo ainda apenas no aparelho não é conhecido.',
      records: [{ id: '10000000-0000-4000-8000-000000000008', offlineId: '10000000-0000-4000-8000-000000000009',
        client: { id: common.client.id, name: 'Cliente', address: 'Rua Teste, 1' },
        seller: { id: common.seller.id, displayName: 'Vendedor' }, origin: 'visit', visitId: common.visitId,
        estimatedWeightKg: '40', desiredDate: '2026-10-30', period: 'morning', observation: 'não exportar',
        requestedAt: '2026-10-29T11:00:00.000Z', serverSavedAt: '2026-10-29T12:00:00.000Z', status: 'pending', version: 1 }],
    };
    const report = scrapAgendaReport(response);
    expect(report.rows[0]).toMatchObject({ client: 'Cliente', estimatedWeight: '40' });
    const keys = report.columns.map(({ key }) => key);
    for (const forbidden of ['id', 'offlineId', 'observation']) expect(keys).not.toContain(forbidden);
  });
});
