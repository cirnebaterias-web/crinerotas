import {
  apiErrorResponseSchema,
  canonicalRouteSchema,
  changeRouteCompositionRequestSchema,
  createRouteDraftRequestSchema,
  myTodayRoutePath,
  reorderRouteExecutionRequestSchema,
  reorderRouteExecutionResultSchema,
  routeCompositionDraftSchema,
  routeDraftSchema,
  routeExecutionOrderPath,
  routePath,
  routePublicationSchema,
  routePublishPath,
  routeTodayResponseSchema,
  routesPath,
  type CanonicalRoute,
} from '@cirne/contracts';
import { syntheticClientIds } from '@cirne/domain';
import { checkIdentity } from './identity';
import { parseLocalOrigin } from './sync';

async function requestJson(
  origin: URL,
  path: string,
  token: string,
  init: {
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH';
    body?: unknown;
    idempotencyKey?: string;
  },
  request: typeof fetch,
) {
  let response: Response;
  try {
    response = await request(new URL(path, origin), {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.idempotencyKey ? { 'Idempotency-Key': init.idempotencyKey } : {}),
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
  executionVersion: number;
  routeStatus: 'published';
  stopCount: number;
  checks: {
    created: boolean;
    published: boolean;
    loadedBySeller: true;
    composition: 'applied' | 'already_current';
    reasonConfirmed: true;
    reordered: 'applied' | 'already_canonical';
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
      !seller.capabilities.includes('route.reorder_self') || !manager.scopeIds.includes(seller.id)) {
    throw new Error('O Vendedor não está ativo ou não pertence ao escopo do Gestor.');
  }

  const initialStops = [
    { clientId: syntheticClientIds[0], plannedOrder: 1, priority: 1 },
    { clientId: syntheticClientIds[1], plannedOrder: 3, priority: 0 },
  ];
  const revisedStops = [
    { clientId: syntheticClientIds[1], plannedOrder: 1, priority: 0 },
    { clientId: syntheticClientIds[2], plannedOrder: 2, priority: 1 },
  ];
  const changeReason = 'Ajuste sintetico de composicao para validacao local';
  const loadToday = async () => routeTodayResponseSchema.parse(await requestJson(
    origin, myTodayRoutePath, sellerAccessToken, {}, request,
  ));
  const existing = await loadToday();
  const serviceDate = existing.availability === 'available'
    ? existing.route.serviceDate
    : existing.serviceDate;

  let loadedRoute: CanonicalRoute;
  let createdNow = false;
  let publishedNow = false;
  if (existing.availability === 'available') {
    loadedRoute = canonicalRouteSchema.parse(existing.route);
  } else {
    const command = createRouteDraftRequestSchema.parse({
      schemaVersion: 1,
      serviceDate,
      sellerId: seller.id,
      stops: initialStops,
    });
    const draft = routeDraftSchema.parse(await requestJson(
      origin, routesPath, managerAccessToken, { method: 'POST', body: command }, request,
    ));
    const publication = routePublicationSchema.parse(await requestJson(
      origin,
      routePublishPath(draft.routeId),
      managerAccessToken,
      { method: 'POST', body: { schemaVersion: 1, expectedVersion: draft.expectedVersion } },
      request,
    ));
    if (publication.routeVersionId !== draft.routeVersionId) {
      throw new Error('A publicação retornada não corresponde ao rascunho criado.');
    }
    createdNow = true;
    publishedNow = true;
    const loaded = await loadToday();
    if (loaded.availability !== 'available') throw new Error('A rota publicada não foi carregada pelo Vendedor.');
    loadedRoute = canonicalRouteSchema.parse(loaded.route);
  }

  const desiredClientIds = revisedStops.map(({ clientId }) => clientId).sort();
  const currentClientIds = loadedRoute.stops.map(({ client }) => client.id).sort();
  let composition: RouteRoundTripResult['checks']['composition'] = 'already_current';
  if (JSON.stringify(currentClientIds) !== JSON.stringify(desiredClientIds)) {
    const command = changeRouteCompositionRequestSchema.parse({
      schemaVersion: 1,
      expectedVersion: loadedRoute.executionVersion,
      reason: changeReason,
      stops: revisedStops,
    });
    const changed = routeCompositionDraftSchema.parse(await requestJson(
      origin,
      routePath(loadedRoute.routeId),
      managerAccessToken,
      { method: 'PATCH', body: command, idempotencyKey: crypto.randomUUID() },
      request,
    ));
    if (!changed.changed || changed.changeSummary.addedClientIds.length !== 1 ||
        changed.changeSummary.removedClientIds.length !== 1) {
      throw new Error('A alteração de composição não confirmou o diff esperado.');
    }
    const publication = routePublicationSchema.parse(await requestJson(
      origin,
      routePublishPath(loadedRoute.routeId),
      managerAccessToken,
      { method: 'POST', body: { schemaVersion: 1, expectedVersion: changed.expectedVersion } },
      request,
    ));
    if (publication.versionNumber !== loadedRoute.versionNumber + 1) {
      throw new Error('A publicação sucessora não avançou a versão da rota.');
    }
    publishedNow = true;
    const reloaded = await loadToday();
    if (reloaded.availability !== 'available') throw new Error('A rota sucessora não foi carregada.');
    loadedRoute = canonicalRouteSchema.parse(reloaded.route);
    composition = 'applied';
  }

  const loadedStops = loadedRoute.stops
    .map(({ client, plannedOrder, priority }) => ({ clientId: client.id, plannedOrder, priority }))
    .sort((left, right) => left.plannedOrder - right.plannedOrder);
  if (loadedRoute.serviceDate !== serviceDate || loadedRoute.seller.id !== seller.id ||
      JSON.stringify(loadedStops) !== JSON.stringify(revisedStops) ||
      loadedRoute.schemaVersion !== 3 || loadedRoute.compositionChange?.reason !== changeReason) {
    throw new Error('O carregamento do Vendedor diverge da composição publicada.');
  }

  const pendingStopIds = [...loadedRoute.stops]
    .filter(({ status }) => status === 'pending')
    .sort((left, right) => right.plannedOrder - left.plannedOrder ||
      right.routeVersionStopId.localeCompare(left.routeVersionStopId))
    .map(({ routeVersionStopId }) => routeVersionStopId);
  const reorderCommand = reorderRouteExecutionRequestSchema.parse({
    schemaVersion: 1,
    expectedVersion: loadedRoute.executionVersion,
    pendingStopIds,
  });
  const reordered = reorderRouteExecutionResultSchema.parse(await requestJson(
    origin,
    routeExecutionOrderPath(loadedRoute.routeId),
    sellerAccessToken,
    { method: 'PUT', body: reorderCommand },
    request,
  ));
  if (reordered.routeId !== loadedRoute.routeId ||
      reordered.routeVersionId !== loadedRoute.routeVersionId ||
      reordered.executionVersion !== loadedRoute.executionVersion + (reordered.changed ? 1 : 0) ||
      reordered.pendingStopIds.length !== pendingStopIds.length ||
      reordered.pendingStopIds.some((stopId, index) => stopId !== pendingStopIds[index])) {
    throw new Error('A reordenação retornada diverge do comando enviado.');
  }

  const confirmed = await loadToday();
  if (confirmed.availability !== 'available') throw new Error('A rota reordenada deixou de estar disponível.');
  const confirmedRoute = canonicalRouteSchema.parse(confirmed.route);
  const confirmedPending = confirmedRoute.stops.filter(({ status }) => status === 'pending');
  if (confirmedRoute.executionVersion !== reordered.executionVersion ||
      confirmedPending.length !== pendingStopIds.length ||
      confirmedPending.some((stop, index) => stop.routeVersionStopId !== pendingStopIds[index]) ||
      confirmedRoute.schemaVersion !== 3 || confirmedRoute.compositionChange?.reason !== changeReason) {
    throw new Error('A leitura canônica não confirmou a rota sucessora.');
  }

  return {
    status: 'ok',
    routeId: confirmedRoute.routeId,
    routeVersion: confirmedRoute.versionNumber,
    executionVersion: confirmedRoute.executionVersion,
    routeStatus: confirmedRoute.status,
    stopCount: confirmedRoute.stops.length,
    checks: {
      created: createdNow,
      published: publishedNow,
      loadedBySeller: true,
      composition,
      reasonConfirmed: true,
      reordered: reordered.changed ? 'applied' : 'already_canonical',
    },
  };
}
