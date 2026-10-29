import {
  apiErrorResponseSchema,
  managementMapPath,
  managementMapResponseSchema,
  managementServiceDateSchema,
  type ManagementMapResponse,
} from '@cirne/contracts';
import { operationalDate, type Clock, systemClock } from './management-day';

export const managementMapExitCodes = {
  success: 0, empty: 2, invalidArgument: 64, dependencyFailure: 69, accessDenied: 77,
} as const;

export class ManagementMapCliError extends Error {
  constructor(public readonly exitCode: number, message: string) { super(message); }
}

export function resolveManagementMapDate(
  value: string | undefined,
  timeZone: string,
  clock: Clock = systemClock,
) {
  if (value === undefined) return operationalDate(timeZone, clock);
  const parsed = managementServiceDateSchema.safeParse(value);
  if (!parsed.success) {
    throw new ManagementMapCliError(managementMapExitCodes.invalidArgument, 'Use --date no formato YYYY-MM-DD.');
  }
  return parsed.data;
}

export async function loadManagementMap(
  baseUrl: string,
  token: string,
  serviceDate: string,
  request: typeof fetch = fetch,
) {
  const url = new URL(managementMapPath, baseUrl);
  url.searchParams.set('serviceDate', serviceDate);
  let response: Response;
  try {
    response = await request(url, {
      headers: { authorization: `Bearer ${token}` }, cache: 'no-store', signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new ManagementMapCliError(managementMapExitCodes.dependencyFailure, 'Projeção do mapa indisponível.');
  }
  const body = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    const failure = apiErrorResponseSchema.safeParse(body);
    const exitCode = response.status === 401 || response.status === 403
      ? managementMapExitCodes.accessDenied
      : response.status === 400 || response.status === 422
        ? managementMapExitCodes.invalidArgument : managementMapExitCodes.dependencyFailure;
    throw new ManagementMapCliError(
      exitCode, failure.success ? failure.data.error.message : 'Projeção do mapa indisponível.',
    );
  }
  const parsed = managementMapResponseSchema.safeParse(body);
  if (!parsed.success || parsed.data.serviceDate !== serviceDate) {
    throw new ManagementMapCliError(managementMapExitCodes.dependencyFailure, 'Resposta do mapa inválida.');
  }
  return parsed.data;
}

export function formatManagementMap(result: ManagementMapResponse) {
  const lines = [
    `Mapa gerencial de ${result.serviceDate}`,
    `${result.totals.routes} rota(s) · ${result.totals.stops} parada(s)`,
    `${result.totals.positioned} posicionada(s) · ${result.totals.unpositioned} sem coordenadas`,
  ];
  for (const route of result.routes) {
    lines.push(`${route.seller.displayName}: ${route.stops.length} parada(s), ${route.stops.filter((stop) => stop.location).length} posicionada(s).`);
  }
  lines.push(result.serverVisibilityNote);
  return lines.join('\n');
}

export async function runManagementMapCommand(options: {
  baseUrl: string; token: string; date?: string; timeZone: string; json: boolean;
  clock?: Clock; request?: typeof fetch;
}) {
  const serviceDate = resolveManagementMapDate(options.date, options.timeZone, options.clock);
  const result = await loadManagementMap(options.baseUrl, options.token, serviceDate, options.request);
  return {
    exitCode: result.availability === 'empty' ? managementMapExitCodes.empty : managementMapExitCodes.success,
    output: options.json ? JSON.stringify(result) : formatManagementMap(result),
  };
}
