import {
  apiErrorResponseSchema, approveScrapCollectionRouteSchema, assignScrapCollectionRouteSchema,
  createScrapCollectionRouteSchema, reorderScrapCollectionRouteSchema, scrapCollectionRouteCandidateSchema,
  reviseScrapCollectionRouteSchema,
  scrapCollectionRouteListSchema, scrapCollectionRouteOperationPath, scrapCollectionRoutePath,
  scrapCollectionRouteSchema, scrapCollectionRoutesPath,
} from '@cirne/contracts';
import { suggestScrapCollectionRoute } from '@cirne/domain';
import { z } from 'zod';

const inputSchema = z.object({ routeId: z.uuid(), routeDate: z.iso.date(),
  generatedAt: z.iso.datetime({ offset: true }), candidates: z.array(scrapCollectionRouteCandidateSchema).min(1).max(500) }).strict();

export function generateScrapCollectionRoute(input: unknown) {
  return scrapCollectionRouteSchema.parse(suggestScrapCollectionRoute(inputSchema.parse(input)));
}

export function scrapCollectionRouteSummary(input: unknown) {
  const route = generateScrapCollectionRoute(input);
  return { status: 'ok' as const, routeId: route.routeId, routeDate: route.routeDate,
    policyVersion: route.policy.version, counts: route.counts,
    stops: route.stops.map(({ suggestedOrder, clientName, address, promisedWeightKg, geographyStatus }) =>
      ({ suggestedOrder, clientName, address, promisedWeightKg, geographyStatus })) };
}

export class ScrapCollectionRouteCliError extends Error {
  constructor(public readonly exitCode: number, message: string) { super(message); }
}

export type ScrapCollectionRouteCommand = 'list' | 'get' | 'create' | 'revise' | 'reorder' | 'approve' | 'assign';

function parse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ScrapCollectionRouteCliError(64, 'Argumentos da rota de coleta inválidos.');
  return result.data;
}

export async function runScrapCollectionRouteCommand(options: {
  baseUrl: string; token: string; operation: ScrapCollectionRouteCommand; date?: string; routeId?: string;
  idempotencyKey?: string; body?: unknown; request?: typeof fetch;
}) {
  const mutation = !['list', 'get'].includes(options.operation);
  const routeId = options.operation === 'list' || options.operation === 'create' ? undefined : parse(z.uuid(), options.routeId);
  const pathname = options.operation === 'list' || options.operation === 'create' ? scrapCollectionRoutesPath
    : options.operation === 'get' ? scrapCollectionRoutePath(routeId!)
      : scrapCollectionRouteOperationPath(routeId!, options.operation);
  const url = new URL(pathname, options.baseUrl);
  if (options.operation === 'list') url.searchParams.set('date', parse(z.iso.date(), options.date));
  const headers: Record<string, string> = { authorization: `Bearer ${options.token}` };
  let body: unknown;
  if (mutation) {
    const key = parse(z.uuid(), options.idempotencyKey);
    body = options.operation === 'create' ? parse(createScrapCollectionRouteSchema, options.body)
      : options.operation === 'revise' ? parse(reviseScrapCollectionRouteSchema, options.body)
        : options.operation === 'reorder' ? parse(reorderScrapCollectionRouteSchema, options.body)
        : options.operation === 'approve' ? parse(approveScrapCollectionRouteSchema, options.body)
          : parse(assignScrapCollectionRouteSchema, options.body);
    headers['idempotency-key'] = key;
    headers['content-type'] = 'application/json';
  }
  let response: Response; let data: unknown;
  try {
    response = await (options.request ?? fetch)(url, { method: mutation ? 'POST' : 'GET', headers,
      body: mutation ? JSON.stringify(body) : undefined, cache: 'no-store', signal: AbortSignal.timeout(30_000) });
    data = await response.json();
  } catch { throw new ScrapCollectionRouteCliError(69, 'Rotas de coleta temporariamente indisponíveis; preserve a chave ao tentar novamente.'); }
  if (!response.ok) {
    const error = apiErrorResponseSchema.safeParse(data);
    const exitCode = response.status === 401 || response.status === 403 ? 77
      : response.status === 409 ? 75 : response.status === 422 ? 64 : 69;
    throw new ScrapCollectionRouteCliError(exitCode, error.success ? error.data.error.message : 'A operação da rota de coleta falhou.');
  }
  if (options.operation === 'list') return parse(scrapCollectionRouteListSchema, data);
  return parse(scrapCollectionRouteSchema, data);
}
