import {
  apiErrorResponseSchema,
  managementDayPath,
  managementDayResponseSchema,
  managementServiceDateSchema,
  type ManagementDayResponse,
} from '@cirne/contracts';

export type Clock = { now(): Date };
export const systemClock: Clock = { now: () => new Date() };

export const managementDayExitCodes = {
  success: 0,
  empty: 2,
  invalidArgument: 64,
  dependencyFailure: 69,
  accessDenied: 77,
} as const;

export class ManagementDayCliError extends Error {
  constructor(public readonly exitCode: number, message: string) { super(message); }
}

export function operationalDate(timeZone: string, clock: Clock = systemClock) {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(clock.now());
  } catch {
    throw new ManagementDayCliError(managementDayExitCodes.invalidArgument, 'Fuso operacional inválido.');
  }
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return managementServiceDateSchema.parse(`${values.year}-${values.month}-${values.day}`);
}

export function resolveManagementDate(value: string | undefined, timeZone: string, clock: Clock = systemClock) {
  if (value === undefined) return operationalDate(timeZone, clock);
  const parsed = managementServiceDateSchema.safeParse(value);
  if (!parsed.success) {
    throw new ManagementDayCliError(managementDayExitCodes.invalidArgument, 'Use --date no formato YYYY-MM-DD.');
  }
  return parsed.data;
}

export async function loadManagementDay(
  baseUrl: string,
  token: string,
  serviceDate: string,
  request: typeof fetch = fetch,
) {
  const url = new URL(managementDayPath, baseUrl);
  url.searchParams.set('serviceDate', serviceDate);
  let response: Response;
  try {
    response = await request(url, {
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
  } catch {
    throw new ManagementDayCliError(managementDayExitCodes.dependencyFailure, 'Serviço gerencial indisponível.');
  }
  const body = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    const error = apiErrorResponseSchema.safeParse(body);
    const message = error.success ? error.data.error.message : 'Serviço gerencial indisponível.';
    const exitCode = response.status === 401 || response.status === 403
      ? managementDayExitCodes.accessDenied
      : response.status === 400 || response.status === 422
        ? managementDayExitCodes.invalidArgument
        : managementDayExitCodes.dependencyFailure;
    throw new ManagementDayCliError(exitCode, message);
  }
  const parsed = managementDayResponseSchema.safeParse(body);
  if (!parsed.success || parsed.data.serviceDate !== serviceDate) {
    throw new ManagementDayCliError(managementDayExitCodes.dependencyFailure, 'Resposta gerencial inválida.');
  }
  return parsed.data;
}

export function formatManagementDay(result: ManagementDayResponse) {
  const lines = [
    `Visão gerencial de ${result.serviceDate}`,
    `Planejadas ${result.totals.planned} · Pendentes ${result.totals.pending} · Em visita ${result.totals.inVisit} · Concluídas ${result.totals.completed} · Não visitadas ${result.totals.notVisited}`,
    `Sincronização conhecida pelo servidor: ${result.sync.pending} pendência(s), ${result.sync.errors} erro(s).`,
    `Última atualização: ${result.lastKnownUpdateAt ?? 'sem atualização conhecida'}`,
  ];
  for (const route of result.routes) {
    lines.push(`${route.seller.displayName}: ${route.counts.planned} planejadas, ${route.counts.completed} concluídas, ${route.counts.notVisited} não visitadas.`);
  }
  lines.push(result.serverVisibilityNote);
  return lines.join('\n');
}

export async function runManagementDayCommand(options: {
  baseUrl: string;
  token: string;
  date?: string;
  timeZone: string;
  json: boolean;
  clock?: Clock;
  request?: typeof fetch;
}) {
  const serviceDate = resolveManagementDate(options.date, options.timeZone, options.clock);
  const result = await loadManagementDay(options.baseUrl, options.token, serviceDate, options.request);
  return {
    exitCode: result.availability === 'empty' ? managementDayExitCodes.empty : managementDayExitCodes.success,
    output: options.json ? JSON.stringify(result) : formatManagementDay(result),
  };
}
