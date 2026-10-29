import {
  apiErrorResponseSchema,
  fieldIntelligenceFilterSchema,
  fieldIntelligencePath,
  fieldIntelligenceResponseSchema,
  type FieldIntelligenceFilter,
  type FieldIntelligenceResponse,
} from '@cirne/contracts';

export type FieldIntelligenceClock = { now(): Date };
export const fieldIntelligenceSystemClock: FieldIntelligenceClock = { now: () => new Date() };

export const fieldIntelligenceExitCodes = {
  success: 0,
  empty: 2,
  invalidArgument: 64,
  dependencyFailure: 69,
  accessDenied: 77,
} as const;

export class FieldIntelligenceCliError extends Error {
  constructor(public readonly exitCode: number, message: string) { super(message); }
}

function operationalDate(timeZone: string, clock: FieldIntelligenceClock) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(clock.now());
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  } catch {
    throw new FieldIntelligenceCliError(fieldIntelligenceExitCodes.invalidArgument, 'Fuso operacional inválido.');
  }
}

function shiftDate(date: string, days: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function currentOperationalWeek(
  timeZone: string,
  clock: FieldIntelligenceClock = fieldIntelligenceSystemClock,
) {
  const today = operationalDate(timeZone, clock);
  const weekday = new Date(`${today}T00:00:00.000Z`).getUTCDay();
  const daysSinceMonday = (weekday + 6) % 7;
  const from = shiftDate(today, -daysSinceMonday);
  return { from, to: shiftDate(from, 6) };
}

export function resolveFieldIntelligenceFilters(
  values: Partial<Record<'section' | 'from' | 'to' | 'sellerId' | 'clientId' | 'competitorId' | 'actionType' | 'cursor', string>>,
  timeZone: string,
  clock: FieldIntelligenceClock = fieldIntelligenceSystemClock,
) {
  const hasFrom = values.from !== undefined;
  const hasTo = values.to !== undefined;
  if (hasFrom !== hasTo) {
    throw new FieldIntelligenceCliError(fieldIntelligenceExitCodes.invalidArgument, 'Informe --from e --to juntos.');
  }
  const week = currentOperationalWeek(timeZone, clock);
  const parsed = fieldIntelligenceFilterSchema.safeParse({
    section: values.section,
    from: values.from ?? week.from,
    to: values.to ?? week.to,
    sellerId: values.sellerId,
    clientId: values.clientId,
    competitorId: values.competitorId,
    actionType: values.actionType,
    cursor: values.cursor,
  });
  if (!parsed.success) {
    throw new FieldIntelligenceCliError(
      fieldIntelligenceExitCodes.invalidArgument,
      parsed.error.issues[0]?.message ?? 'Filtros de inteligência inválidos.',
    );
  }
  return parsed.data;
}

export async function loadFieldIntelligence(
  baseUrl: string,
  token: string,
  filters: FieldIntelligenceFilter,
  request: typeof fetch = fetch,
) {
  const url = new URL(fieldIntelligencePath, baseUrl);
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
    throw new FieldIntelligenceCliError(fieldIntelligenceExitCodes.dependencyFailure, 'Inteligência de campo indisponível.');
  }
  if (!response.ok) {
    const parsedError = apiErrorResponseSchema.safeParse(body);
    const message = parsedError.success ? parsedError.data.error.message : 'Inteligência de campo indisponível.';
    const exitCode = response.status === 401 || response.status === 403
      ? fieldIntelligenceExitCodes.accessDenied
      : response.status === 400 || response.status === 422
        ? fieldIntelligenceExitCodes.invalidArgument
        : fieldIntelligenceExitCodes.dependencyFailure;
    throw new FieldIntelligenceCliError(exitCode, message);
  }
  const parsed = fieldIntelligenceResponseSchema.safeParse(body);
  if (!parsed.success || parsed.data.section !== filters.section) {
    throw new FieldIntelligenceCliError(fieldIntelligenceExitCodes.dependencyFailure, 'Resposta de inteligência inválida.');
  }
  return parsed.data;
}

export function formatFieldIntelligence(result: FieldIntelligenceResponse) {
  const lines = [
    `Inteligência de campo · ${result.section} · ${result.filters.from} a ${result.filters.to}`,
    `Registros no conjunto filtrado: ${result.indicators.records}`,
    `Última confirmação: ${result.lastConfirmedAt ?? 'nenhuma confirmação no período'}`,
  ];
  if (result.section === 'scrap') {
    lines.push(`Coletado: ${result.indicators.collectedWeightKg} kg · Agendado: ${result.indicators.scheduledWeightKg} kg`);
  }
  lines.push(`Página: ${result.records.length} registro(s).`);
  result.records.forEach((record, index) => lines.push(`Registro ${index + 1}: ${JSON.stringify(record)}`));
  if (result.nextCursor) lines.push(`Próximo cursor: ${result.nextCursor}`);
  lines.push(result.serverVisibilityNote);
  return lines.join('\n');
}

export async function runFieldIntelligenceCommand(options: {
  baseUrl: string;
  token: string;
  values: Parameters<typeof resolveFieldIntelligenceFilters>[0];
  timeZone: string;
  json: boolean;
  clock?: FieldIntelligenceClock;
  request?: typeof fetch;
}) {
  const filters = resolveFieldIntelligenceFilters(options.values, options.timeZone, options.clock);
  const result = await loadFieldIntelligence(options.baseUrl, options.token, filters, options.request);
  return {
    exitCode: result.indicators.records === 0 ? fieldIntelligenceExitCodes.empty : fieldIntelligenceExitCodes.success,
    output: options.json ? JSON.stringify(result) : formatFieldIntelligence(result),
  };
}
