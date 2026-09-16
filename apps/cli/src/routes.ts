import {
  apiErrorResponseSchema,
  canonicalRouteSchema,
  createRouteDraftRequestSchema,
  myTodayRoutePath,
  routeDraftSchema,
  routePublishPath,
  routePublicationSchema,
  routeTodayResponseSchema,
  routesPath,
} from '@cirne/contracts';
import { syntheticClientIds } from '@cirne/domain';
import { checkIdentity } from './identity';
import { parseLocalOrigin } from './sync';

async function requestJson(
  origin: URL,
  path: string,
  token: string,
  init: { method?: 'GET' | 'POST'; body?: unknown },
  request: typeof fetch,
) {
  let response: Response;
  try {
    response = await request(new URL(path, origin), {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error('Aplicação inacessível ou timeout durante o round-trip de rota.');
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error('Resposta de rota incompatível com o contrato.');
  }
  if (!response.ok) {
    const parsed = apiErrorResponseSchema.safeParse(body);
    throw new Error(parsed.success
      ? `${parsed.data.error.message} (HTTP ${response.status}).`
      : `Rota retornou HTTP ${response.status}.`);
  }
  return body;
}

export interface RouteRoundTripResult {
  status: 'ok';
  routeId: string;
  routeVersion: number;
  routeStatus: 'published';
  stopCount: number;
  checks: {
    created: true;
    published: true;
    loadedBySeller: true;
  };
}

export async function runRouteRoundTrip(
  baseUrl: string,
  managerAccessToken: string,
  sellerAccessToken: string,
  request: typeof fetch = fetch,
): Promise<RouteRoundTripResult> {
  if (!managerAccessToken.trim() || !sellerAccessToken.trim()) {
    throw new Error('Tokens de Gestor e Vendedor são obrigatórios.');
  }
  const origin = parseLocalOrigin(baseUrl);
  const manager = await checkIdentity(baseUrl, managerAccessToken, request);
  const seller = await checkIdentity(baseUrl, sellerAccessToken, request);
  if (!manager.roles.includes('manager') || !manager.capabilities.includes('route.plan_scoped')) {
    throw new Error('O token de Gestor não possui capacidade de planejamento de rota.');
  }
  if (!seller.roles.includes('seller') || !seller.capabilities.includes('route.read_self') ||
      !manager.scopeIds.includes(seller.id)) {
    throw new Error('O Vendedor não está ativo ou não pertence ao escopo do Gestor.');
  }

  const plannedStops = [
    { clientId: syntheticClientIds[0], plannedOrder: 1, priority: 1 },
    { clientId: syntheticClientIds[1], plannedOrder: 3, priority: 0 },
  ];
  const expectedStops = plannedStops.map(({ clientId, plannedOrder, priority }) => ({
    clientId,
    plannedOrder,
    priority,
  }));
  const loadToday = async () => routeTodayResponseSchema.parse(await requestJson(
    origin,
    myTodayRoutePath,
    sellerAccessToken,
    {},
    request,
  ));
  const existing = await loadToday();
  const serviceDate = existing.availability === 'available'
    ? existing.route.serviceDate
    : existing.serviceDate;
  const command = createRouteDraftRequestSchema.parse({
    schemaVersion: 1,
    serviceDate,
    sellerId: seller.id,
    stops: plannedStops,
  });
  const validateLoadedRoute = (
    input: unknown,
    expected?: { routeId: string; routeVersionId: string; versionNumber: number },
  ) => {
    const route = canonicalRouteSchema.parse(input);
    const loadedStops = route.stops.map(({ client, plannedOrder, priority }) => ({
      clientId: client.id,
      plannedOrder,
      priority,
    }));
    if (route.serviceDate !== serviceDate || route.seller.id !== seller.id ||
        JSON.stringify(loadedStops) !== JSON.stringify(expectedStops) ||
        (expected && (route.routeId !== expected.routeId ||
          route.routeVersionId !== expected.routeVersionId || route.versionNumber !== expected.versionNumber))) {
      throw new Error('O carregamento do Vendedor diverge da versão publicada.');
    }
    return route;
  };
  const asResult = (route: ReturnType<typeof validateLoadedRoute>): RouteRoundTripResult => ({
    status: 'ok',
    routeId: route.routeId,
    routeVersion: route.versionNumber,
    routeStatus: route.status,
    stopCount: route.stops.length,
    checks: { created: true, published: true, loadedBySeller: true },
  });

  if (existing.availability === 'available') return asResult(validateLoadedRoute(existing.route));

  const draft = routeDraftSchema.parse(await requestJson(
    origin,
    routesPath,
    managerAccessToken,
    { method: 'POST', body: command },
    request,
  ));
  if (draft.sellerId !== seller.id || draft.serviceDate !== serviceDate) {
    throw new Error('O rascunho retornado não corresponde ao comando enviado.');
  }

  const publication = routePublicationSchema.parse(await requestJson(
    origin,
    routePublishPath(draft.routeId),
    managerAccessToken,
    { method: 'POST', body: { schemaVersion: 1, expectedVersion: draft.expectedVersion } },
    request,
  ));
  if (publication.routeId !== draft.routeId || publication.routeVersionId !== draft.routeVersionId) {
    throw new Error('A publicação retornada não corresponde ao rascunho criado.');
  }

  const loaded = await loadToday();
  if (loaded.availability !== 'available') throw new Error('A rota publicada não foi carregada pelo Vendedor.');
  return asResult(validateLoadedRoute(loaded.route, {
    routeId: draft.routeId,
    routeVersionId: draft.routeVersionId,
    versionNumber: publication.versionNumber,
  }));
}
