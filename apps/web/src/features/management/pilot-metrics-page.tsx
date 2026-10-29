import { cookies } from 'next/headers';
import type { CookieMethodsServer } from '@supabase/ssr';
import { readServerConfig } from '@cirne/config/server';
import type { PilotMetricsFilter } from '@cirne/contracts';
import { createCallerScopedClient, IdentityRequestError, resolveIdentityRequest } from '../../server/identity';
import { getPilotMetrics, normalizePilotMetricsFilters } from '../../server/pilot-metrics/service';
import { SupabasePilotMetricsRepository } from '../../server/pilot-metrics/supabase-repository';
import { RouteServiceFailure } from '../../server/routes/service';
import { PilotMetricsDashboard, type PilotMetricsInitialState } from './pilot-metrics-dashboard';

export async function PilotMetricsPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const parameters = await searchParams;
  const today = new Date().toISOString().slice(0, 10);
  const timeZone = readServerConfig(process.env).OPERATIONAL_TIME_ZONE;
  let selectedFilters: PilotMetricsFilter = { from: today, to: today };
  let initial: PilotMetricsInitialState;
  try {
    const keys = ['from', 'to', 'sellerId', 'clientId', 'cursor'] as const;
    if (keys.some((key) => Array.isArray(parameters[key]))) {
      throw new RouteServiceFailure('VALIDATION_FAILED', 'Cada filtro deve ser informado uma única vez.', false);
    }
    const filters = normalizePilotMetricsFilters(
      Object.fromEntries(keys.map((key) => [key, parameters[key] as string | undefined])), timeZone,
    );
    selectedFilters = filters;
    const store = await cookies();
    const cookieMethods: CookieMethodsServer = {
      getAll: () => store.getAll().map(({ name, value }) => ({ name, value })),
      setAll: () => { /* Server Components cannot persist refreshed cookies. */ },
    };
    const identity = await resolveIdentityRequest(null, cookieMethods);
    const client = createCallerScopedClient(null, cookieMethods);
    const result = await getPilotMetrics(identity, filters, timeZone, new SupabasePilotMetricsRepository(client));
    const hasCohort = result.metrics.some((metric) =>
      metric.coverage !== 'external_source_required' && (metric.observation?.denominator ?? 0) > 0,
    );
    initial = { kind: hasCohort ? 'ready' : 'empty', filters, result };
  } catch (error) {
    const forbidden = (error instanceof IdentityRequestError && [401, 403].includes(error.status)) ||
      (error instanceof RouteServiceFailure && error.code === 'FORBIDDEN');
    const message = error instanceof RouteServiceFailure && error.code === 'VALIDATION_FAILED'
      ? error.message
      : forbidden ? 'Seu perfil não tem acesso às métricas do piloto.'
        : 'As métricas do piloto estão temporariamente indisponíveis. Tente novamente.';
    initial = { kind: forbidden ? 'forbidden' : 'recoverable_error', filters: selectedFilters, message };
  }
  const key = initial.kind === 'ready' || initial.kind === 'empty'
    ? `${initial.filters.from}:${initial.filters.to}:${initial.filters.sellerId ?? ''}:${initial.filters.clientId ?? ''}:${initial.result.generatedAt}`
    : `${initial.filters.from}:${initial.filters.to}:${initial.filters.sellerId ?? ''}:${initial.filters.clientId ?? ''}:${initial.kind}`;
  return <PilotMetricsDashboard key={key} initial={initial} timeZone={timeZone} />;
}
