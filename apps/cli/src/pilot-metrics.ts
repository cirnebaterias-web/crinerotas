import {
  apiErrorResponseSchema,
  pilotMetricsFilterSchema,
  pilotMetricsPath,
  pilotMetricsResponseSchema,
  type PilotMetricsFilter,
  type PilotMetricsResponse,
} from '@cirne/contracts';
import { currentOperationalWeek, type FieldIntelligenceClock as PilotMetricsClock } from './field-intelligence';

export type { PilotMetricsClock };

export const pilotMetricsExitCodes = {
  success: 0,
  empty: 2,
  invalidArgument: 64,
  dependencyFailure: 69,
  accessDenied: 77,
} as const;

export class PilotMetricsCliError extends Error {
  constructor(public readonly exitCode: number, message: string) { super(message); }
}

export function resolvePilotMetricsFilters(
  values: Partial<Record<'from' | 'to' | 'sellerId' | 'clientId' | 'cursor', string>>,
  timeZone: string,
  clock?: PilotMetricsClock,
) {
  if ((values.from !== undefined) !== (values.to !== undefined)) {
    throw new PilotMetricsCliError(pilotMetricsExitCodes.invalidArgument, 'Informe --from e --to juntos.');
  }
  const week = currentOperationalWeek(timeZone, clock);
  const parsed = pilotMetricsFilterSchema.safeParse({
    from: values.from ?? week.from,
    to: values.to ?? week.to,
    sellerId: values.sellerId,
    clientId: values.clientId,
    cursor: values.cursor,
  });
  if (!parsed.success) {
    throw new PilotMetricsCliError(
      pilotMetricsExitCodes.invalidArgument,
      parsed.error.issues[0]?.message ?? 'Filtros das métricas do piloto inválidos.',
    );
  }
  return parsed.data;
}

export async function loadPilotMetrics(
  baseUrl: string,
  token: string,
  filters: PilotMetricsFilter,
  request: typeof fetch = fetch,
) {
  const url = new URL(pilotMetricsPath, baseUrl);
  for (const [key, value] of Object.entries(filters)) if (value !== undefined) url.searchParams.set(key, value);
  let response: Response;
  let body: unknown;
  try {
    response = await request(url, {
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
    body = await response.json();
  } catch {
    throw new PilotMetricsCliError(pilotMetricsExitCodes.dependencyFailure, 'Métricas do piloto indisponíveis.');
  }
  if (!response.ok) {
    const parsedError = apiErrorResponseSchema.safeParse(body);
    const message = parsedError.success ? parsedError.data.error.message : 'Métricas do piloto indisponíveis.';
    const exitCode = response.status === 401 || response.status === 403
      ? pilotMetricsExitCodes.accessDenied
      : response.status === 400 || response.status === 422
        ? pilotMetricsExitCodes.invalidArgument
        : pilotMetricsExitCodes.dependencyFailure;
    throw new PilotMetricsCliError(exitCode, message);
  }
  const parsed = pilotMetricsResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new PilotMetricsCliError(pilotMetricsExitCodes.dependencyFailure, 'Resposta das métricas do piloto inválida.');
  }
  return parsed.data;
}

export function formatPilotMetrics(result: PilotMetricsResponse) {
  const lines = [
    `Métricas do piloto · ${result.filters.from} a ${result.filters.to}`,
    `Última confirmação: ${result.lastServerConfirmedAt ?? 'nenhuma confirmação no período'}`,
  ];
  for (const metric of result.metrics) {
    const observed = metric.observation
      ? metric.observation.denominator === 0
        ? 'Não avaliável — sem coorte confirmada pelo servidor'
        : `${metric.observation.percentage}% (${metric.observation.numerator}/${metric.observation.denominator})`
      : `Não avaliável — fonte necessária: ${metric.requiredSource}`;
    lines.push(`${metric.id} · ${metric.name}: ${observed} · ${metric.assessment}`);
  }
  lines.push(`Drill-down: ${result.records.length} visita(s).`);
  if (result.nextCursor) lines.push(`Próximo cursor: ${result.nextCursor}`);
  lines.push(result.serverVisibilityNote);
  return lines.join('\n');
}

export async function runPilotMetricsCommand(options: {
  baseUrl: string;
  token: string;
  values: Parameters<typeof resolvePilotMetricsFilters>[0];
  timeZone: string;
  json: boolean;
  clock?: PilotMetricsClock;
  request?: typeof fetch;
}) {
  const filters = resolvePilotMetricsFilters(options.values, options.timeZone, options.clock);
  const result = await loadPilotMetrics(options.baseUrl, options.token, filters, options.request);
  const hasServerCohort = result.metrics.some((metric) =>
    metric.coverage !== 'external_source_required' && (metric.observation?.denominator ?? 0) > 0,
  );
  return {
    exitCode: hasServerCohort ? pilotMetricsExitCodes.success : pilotMetricsExitCodes.empty,
    output: options.json ? JSON.stringify(result) : formatPilotMetrics(result),
  };
}
