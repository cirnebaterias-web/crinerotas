import { describe, expect, it, vi } from 'vitest';
import type { PilotMetric, PilotMetricsResponse } from '@cirne/contracts';
import {
  formatPilotMetrics, loadPilotMetrics, pilotMetricsExitCodes,
  resolvePilotMetricsFilters, runPilotMetricsCommand,
} from './pilot-metrics';

const metricIds: PilotMetric['id'][] = ['SM-01', 'SM-02', 'SM-03', 'SM-04', 'SM-05', 'SM-06', 'SM-07', 'SM-08', 'SM-09'];
const response = (denominator = 0): PilotMetricsResponse => ({
  schemaVersion: 1,
  filters: { from: '2026-10-26', to: '2026-11-01' },
  generatedAt: '2026-10-28T15:00:00.000Z',
  lastServerConfirmedAt: null,
  metrics: metricIds.map((id) => {
    const external = ['SM-01', 'SM-06', 'SM-07', 'SM-08', 'SM-09'].includes(id);
    return {
      id, name: `Métrica ${id}`,
      target: { operator: 'gte', value: '90', unit: 'percent' },
      formula: 'Fórmula aprovada', source: 'Fonte aprovada', periodicity: ['weekly'],
      coverage: external ? 'external_source_required' : id === 'SM-05' ? 'partial_server_view' : 'server_confirmed_cohort',
      assessment: external || denominator === 0 ? 'not_evaluable' : 'provisional_met',
      observation: external ? null : {
        numerator: denominator, denominator, percentage: denominator === 0 ? null : '100',
        exclusions: { windowOpen: 0, clockSuspicious: 0 },
      },
      requiredSource: external ? 'Fonte externa aprovada' : null,
      note: 'Resultado provisório e limitado.',
    } as PilotMetric;
  }),
  records: [], nextCursor: null,
  serverVisibilityNote: 'Somente fatos confirmados pelo servidor são observados; fontes externas e conteúdo ainda apenas no aparelho permanecem não avaliáveis.',
});

describe('pilot metrics CLI', () => {
  it('uses the operational week and validates paired dates', () => {
    expect(resolvePilotMetricsFilters({}, 'America/Sao_Paulo', {
      now: () => new Date('2026-10-28T15:00:00.000Z'),
    })).toEqual({ from: '2026-10-26', to: '2026-11-01' });
    expect(() => resolvePilotMetricsFilters({ from: '2026-10-01' }, 'UTC')).toThrow('juntos');
  });

  it('returns exit 2 when the server-confirmed cohort is empty', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(response()), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    const result = await runPilotMetricsCommand({
      baseUrl: 'https://cirne.invalid', token: 'synthetic', values: {}, json: true,
      timeZone: 'America/Sao_Paulo', clock: { now: () => new Date('2026-10-28T15:00:00.000Z') }, request,
    });
    expect(result.exitCode).toBe(pilotMetricsExitCodes.empty);
  });

  it('maps denial and dependency failures to stable codes', async () => {
    const filters = resolvePilotMetricsFilters({}, 'UTC', { now: () => new Date('2026-10-28T15:00:00.000Z') });
    const denied = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: {
      code: 'FORBIDDEN', message: 'Acesso negado.', recoverable: false,
      timestamp: '2026-10-28T15:00:00.000Z', requestId: '11111111-1111-4111-8111-111111111111',
    } }), { status: 403, headers: { 'content-type': 'application/json' } }));
    await expect(loadPilotMetrics('https://cirne.invalid', 'synthetic', filters, denied))
      .rejects.toMatchObject({ exitCode: pilotMetricsExitCodes.accessDenied });
    const unavailable = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'));
    await expect(loadPilotMetrics('https://cirne.invalid', 'synthetic', filters, unavailable))
      .rejects.toMatchObject({ exitCode: pilotMetricsExitCodes.dependencyFailure });
  });

  it('labels external sources and server observations honestly', () => {
    const output = formatPilotMetrics(response(1));
    expect(output).toContain('SM-01 · Métrica SM-01: Não avaliável — fonte necessária');
    expect(output).toContain('SM-02 · Métrica SM-02: 100% (1/1)');
  });
});
