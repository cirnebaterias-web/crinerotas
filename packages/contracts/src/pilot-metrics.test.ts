import { describe, expect, it } from 'vitest';
import { pilotMetricsResponseSchema, type PilotMetric } from './index';

function metric(id: PilotMetric['id']): PilotMetric {
  const external = ['SM-01', 'SM-06', 'SM-07', 'SM-08', 'SM-09'].includes(id);
  return {
    id, name: id, target: { operator: id === 'SM-07' ? 'eq' : 'gte', value: id === 'SM-07' ? '0' : '90', unit: id === 'SM-07' ? 'count' : 'percent' },
    formula: 'Fórmula aprovada', source: 'Fonte aprovada', periodicity: ['weekly'],
    coverage: external ? 'external_source_required' : id === 'SM-05' ? 'partial_server_view' : 'server_confirmed_cohort',
    assessment: external ? 'not_evaluable' : 'provisional_met',
    observation: external ? null : { numerator: 1, denominator: 1, percentage: '100', exclusions: { windowOpen: 0, clockSuspicious: 0 } },
    requiredSource: external ? 'Fonte externa necessária' : null,
    note: 'Resultado provisório e explicitamente limitado.',
  };
}

function response() {
  return {
    schemaVersion: 1, filters: { from: '2026-10-26', to: '2026-11-01' },
    generatedAt: '2026-10-28T12:00:00Z', lastServerConfirmedAt: null,
    metrics: ['SM-01', 'SM-02', 'SM-03', 'SM-04', 'SM-05', 'SM-06', 'SM-07', 'SM-08', 'SM-09'].map((id) => metric(id as PilotMetric['id'])),
    records: [], nextCursor: null,
    serverVisibilityNote: 'Somente fatos confirmados pelo servidor são observados; fontes externas e conteúdo ainda apenas no aparelho permanecem não avaliáveis.',
  };
}

describe('pilot metrics contract', () => {
  it('accepts all nine metrics with honest coverage', () => {
    expect(pilotMetricsResponseSchema.parse(response()).metrics).toHaveLength(9);
  });

  it('rejects a fabricated external zero or positive assessment', () => {
    const value = response();
    value.metrics[0] = { ...value.metrics[0]!, assessment: 'provisional_met', observation: { numerator: 0, denominator: 0, percentage: null, exclusions: { windowOpen: 0, clockSuspicious: 0 } } } as PilotMetric;
    expect(pilotMetricsResponseSchema.safeParse(value).success).toBe(false);
  });

  it('rejects duplicate metrics and percentage without a denominator', () => {
    const duplicate = response(); duplicate.metrics[8] = duplicate.metrics[7]!;
    expect(pilotMetricsResponseSchema.safeParse(duplicate).success).toBe(false);
    const invalid = response();
    invalid.metrics[1] = { ...invalid.metrics[1]!, observation: { numerator: 0, denominator: 0, percentage: '0', exclusions: { windowOpen: 0, clockSuspicious: 0 } } } as PilotMetric;
    expect(pilotMetricsResponseSchema.safeParse(invalid).success).toBe(false);
  });
});
