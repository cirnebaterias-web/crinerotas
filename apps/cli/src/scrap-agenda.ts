import {
  apiErrorResponseSchema,
  scrapAgendaFilterSchema,
  scrapAgendaPath,
  scrapAgendaResponseSchema,
  type ScrapAgendaFilter,
  type ScrapAgendaResponse,
} from '@cirne/contracts';
import {
  currentOperationalWeek,
  type FieldIntelligenceClock as ScrapAgendaClock,
} from './field-intelligence';

export type { ScrapAgendaClock };

export const scrapAgendaExitCodes = {
  success: 0,
  empty: 2,
  invalidArgument: 64,
  dependencyFailure: 69,
  accessDenied: 77,
} as const;

export class ScrapAgendaCliError extends Error {
  constructor(public readonly exitCode: number, message: string) { super(message); }
}

export function resolveScrapAgendaFilters(
  values: Partial<Record<'from' | 'to' | 'status' | 'period' | 'sellerId' | 'clientId' | 'cursor', string>>,
  timeZone: string,
  clock?: ScrapAgendaClock,
) {
  const hasFrom = values.from !== undefined;
  const hasTo = values.to !== undefined;
  if (hasFrom !== hasTo) {
    throw new ScrapAgendaCliError(scrapAgendaExitCodes.invalidArgument, 'Informe --from e --to juntos.');
  }
  const week = currentOperationalWeek(timeZone, clock);
  const parsed = scrapAgendaFilterSchema.safeParse({
    from: values.from ?? week.from,
    to: values.to ?? week.to,
    status: values.status ?? 'pending',
    period: values.period,
    sellerId: values.sellerId,
    clientId: values.clientId,
    cursor: values.cursor,
  });
  if (!parsed.success) {
    throw new ScrapAgendaCliError(
      scrapAgendaExitCodes.invalidArgument,
      parsed.error.issues[0]?.message ?? 'Filtros da agenda de sucata inválidos.',
    );
  }
  return parsed.data;
}

export async function loadScrapAgenda(
  baseUrl: string,
  token: string,
  filters: ScrapAgendaFilter,
  request: typeof fetch = fetch,
) {
  const url = new URL(scrapAgendaPath, baseUrl);
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
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
    throw new ScrapAgendaCliError(scrapAgendaExitCodes.dependencyFailure, 'Agenda de sucata indisponível.');
  }
  if (!response.ok) {
    const parsedError = apiErrorResponseSchema.safeParse(body);
    const message = parsedError.success ? parsedError.data.error.message : 'Agenda de sucata indisponível.';
    const exitCode = response.status === 401 || response.status === 403
      ? scrapAgendaExitCodes.accessDenied
      : response.status === 400 || response.status === 422
        ? scrapAgendaExitCodes.invalidArgument
        : scrapAgendaExitCodes.dependencyFailure;
    throw new ScrapAgendaCliError(exitCode, message);
  }
  const parsed = scrapAgendaResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new ScrapAgendaCliError(scrapAgendaExitCodes.dependencyFailure, 'Resposta da agenda de sucata inválida.');
  }
  return parsed.data;
}

export function formatScrapAgenda(result: ScrapAgendaResponse) {
  const lines = [
    `Agenda de sucata · ${result.filters.from} a ${result.filters.to}`,
    `Pendências: ${result.indicators.records} · Peso estimado: ${result.indicators.scheduledKg} kg`,
    `Última confirmação: ${result.lastServerConfirmedAt ?? 'nenhuma confirmação no período'}`,
  ];
  result.records.forEach((record, index) => {
    lines.push(`Pendência ${index + 1}: ${record.client.name} · ${record.desiredDate} · ${record.period} · ${record.estimatedWeightKg} kg · Pendente`);
  });
  if (result.nextCursor) lines.push(`Próximo cursor: ${result.nextCursor}`);
  lines.push(result.serverVisibilityNote);
  return lines.join('\n');
}

export async function runScrapAgendaCommand(options: {
  baseUrl: string;
  token: string;
  values: Parameters<typeof resolveScrapAgendaFilters>[0];
  timeZone: string;
  json: boolean;
  clock?: ScrapAgendaClock;
  request?: typeof fetch;
}) {
  const filters = resolveScrapAgendaFilters(options.values, options.timeZone, options.clock);
  const result = await loadScrapAgenda(options.baseUrl, options.token, filters, options.request);
  return {
    exitCode: result.indicators.records === 0 ? scrapAgendaExitCodes.empty : scrapAgendaExitCodes.success,
    output: options.json ? JSON.stringify(result) : formatScrapAgenda(result),
  };
}
