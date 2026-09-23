import {
  apiErrorResponseSchema,
  competitorPriceParameterSetSchema,
  competitorPricesResultSchema,
  currentParameterSetPath,
  myTodayRoutePath,
  routeTodayResponseSchema,
  saveCompetitorPricesRequestSchema,
  startVisitRequestSchema,
  saveStockRequestSchema,
  stockSnapshotResultSchema,
  visitCompetitorPricesPath,
  visitStockPath,
  visitStartResultSchema,
  visitsPath,
} from '@cirne/contracts';
import { checkIdentity } from './identity';
import { parseLocalOrigin } from './sync';

async function requestJson(
  origin: URL,
  path: string,
  token: string,
  init: RequestInit,
  request: typeof fetch,
) {
  let response: Response;
  try {
    response = await request(new URL(path, origin), {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...init.headers },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error('Aplicação inacessível ou timeout durante o round-trip de visita.');
  }
  let body: unknown;
  try { body = await response.json(); }
  catch { throw new Error('Resposta de visita incompatível com o contrato.'); }
  if (!response.ok) {
    const parsed = apiErrorResponseSchema.safeParse(body);
    const error = new Error(parsed.success
      ? `${parsed.data.error.message} (HTTP ${response.status}).`
      : `Visita retornou HTTP ${response.status}.`);
    Object.assign(error, { status: response.status });
    throw error;
  }
  return body;
}

export interface VisitRoundTripResult {
  status: 'ok';
  visitId: string;
  visitStatus: 'in_progress';
  checks: {
    started: true;
    replayMatched: true;
    divergentRejected: true;
    canonicalContext: true;
    stockSaved: true;
    stockReplayMatched: true;
    stockDivergentRejected: true;
    pricesSaved: true;
    pricesReplayMatched: true;
    pricesDivergentRejected: true;
  };
}

export async function runVisitRoundTrip(
  baseUrl: string,
  sellerAccessToken: string,
  request: typeof fetch = fetch,
): Promise<VisitRoundTripResult> {
  if (!sellerAccessToken.trim()) throw new Error('Token de Vendedor obrigatório.');
  const origin = parseLocalOrigin(baseUrl);
  const seller = await checkIdentity(baseUrl, sellerAccessToken, request);
  if (!seller.roles.includes('seller') || !seller.capabilities.includes('visit.start_self')) {
    throw new Error('O token não pertence a um Vendedor autorizado a iniciar visitas.');
  }

  const routeResponse = routeTodayResponseSchema.parse(await requestJson(
    origin,
    myTodayRoutePath,
    sellerAccessToken,
    { method: 'GET' },
    request,
  ));
  if (routeResponse.availability !== 'available') {
    throw new Error('Nenhuma rota sintética publicada está disponível para o Vendedor.');
  }
  const stop = routeResponse.route.stops.find(({ status }) => status === 'pending');
  if (!stop) throw new Error('A rota sintética não possui parada pendente para iniciar.');

  const deviceId = crypto.randomUUID();
  const idempotencyKey = crypto.randomUUID();
  const deviceStartedAt = new Date().toISOString();
  const command = startVisitRequestSchema.parse({
    schemaVersion: 1,
    offlineId: crypto.randomUUID(),
    routeVersionStopId: stop.routeVersionStopId,
    deviceStartedAt,
  });
  const send = (body: unknown) => requestJson(origin, visitsPath, sellerAccessToken, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
      'X-Device-Id': deviceId,
    },
    body: JSON.stringify(body),
  }, request);

  const first = visitStartResultSchema.parse(await send(command));
  const replay = visitStartResultSchema.parse(await send(command));
  let divergentRejected = false;
  try {
    await send({ ...command, deviceStartedAt: new Date(Date.parse(deviceStartedAt) + 1_000).toISOString() });
  } catch (error) {
    divergentRejected = error instanceof Error && 'status' in error && error.status === 409;
  }
  if (JSON.stringify(first) !== JSON.stringify(replay)) {
    throw new Error('A repetição idempotente não devolveu o resultado canônico original.');
  }
  if (!divergentRejected) {
    throw new Error('O servidor não rejeitou a chave idempotente com conteúdo divergente.');
  }
  if (first.offlineId !== command.offlineId || first.deviceId !== deviceId ||
      first.routeVersionStopId !== stop.routeVersionStopId ||
      first.routeVersionId !== routeResponse.route.routeVersionId ||
      first.contextSnapshot.sourceRouteVersionId !== routeResponse.route.routeVersionId ||
      first.sellerId !== seller.id || first.clientId !== stop.client.id ||
      first.contextSnapshot.client.id !== stop.client.id ||
      first.contextSnapshot.seller.id !== seller.id) {
    throw new Error('O contexto canônico da visita não corresponde à rota publicada.');
  }

  const stockKey = crypto.randomUUID();
  const stockCommand = saveStockRequestSchema.parse({
    schemaVersion: 1,
    offlineId: command.offlineId,
    heliarQuantity: 0,
    mouraQuantity: 0,
    deviceSavedAt: new Date().toISOString(),
  });
  const sendStock = (body: unknown) => requestJson(
    origin,
    visitStockPath(command.offlineId),
    sellerAccessToken,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': stockKey,
        'X-Device-Id': deviceId,
      },
      body: JSON.stringify(body),
    },
    request,
  );
  const stock = stockSnapshotResultSchema.parse(await sendStock(stockCommand));
  const stockReplay = stockSnapshotResultSchema.parse(await sendStock(stockCommand));
  let stockDivergentRejected = false;
  try {
    await sendStock({ ...stockCommand, mouraQuantity: 1 });
  } catch (error) {
    stockDivergentRejected = error instanceof Error && 'status' in error && error.status === 409;
  }
  if (JSON.stringify(stock) !== JSON.stringify(stockReplay) || stock.visitId !== first.visitId ||
      stock.heliarQuantity !== 0 || stock.mouraQuantity !== 0) {
    throw new Error('O estoque não foi reconhecido de forma canônica e idempotente.');
  }
  if (!stockDivergentRejected) {
    throw new Error('O servidor não rejeitou o estoque divergente com a mesma chave.');
  }
  const parameterAt = `${routeResponse.route.serviceDate}T12:00:00.000Z`;
  const parameters = competitorPriceParameterSetSchema.parse(await requestJson(
    origin,
    `${currentParameterSetPath}?at=${encodeURIComponent(parameterAt)}`,
    sellerAccessToken,
    { method: 'GET' },
    request,
  ));
  if (parameters.parameterSetId !== first.parameterSetId) {
    throw new Error('O catálogo de preços não corresponde ao conjunto vinculado à visita.');
  }
  const competitor = parameters.values.competitors[0];
  const technology = parameters.values.technologies[0];
  const condition = parameters.values.conditions[0];
  if (!competitor || !technology || !condition) {
    throw new Error('Catálogo AB-02 incompleto para o diagnóstico de Preços.');
  }
  const pricesKey = crypto.randomUUID();
  const pricesCommand = saveCompetitorPricesRequestSchema.parse({
    schemaVersion: 1,
    offlineId: command.offlineId,
    availability: 'available',
    quotations: [{
      competitorId: competitor.id,
      modelOrAmperage: 'Diagnóstico sintético',
      technologyId: technology.id,
      priceBrl: '1',
      conditionId: condition.id,
      observation: 'Gerado pelo comando ops:visits.',
    }],
    deviceSavedAt: new Date().toISOString(),
  });
  if (pricesCommand.availability !== 'available') {
    throw new Error('O diagnóstico de Preços exige uma cotação sintética.');
  }
  const sendPrices = (body: unknown) => requestJson(
    origin,
    visitCompetitorPricesPath(command.offlineId),
    sellerAccessToken,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': pricesKey,
        'X-Device-Id': deviceId,
      },
      body: JSON.stringify(body),
    },
    request,
  );
  const prices = competitorPricesResultSchema.parse(await sendPrices(pricesCommand));
  const pricesReplay = competitorPricesResultSchema.parse(await sendPrices(pricesCommand));
  let pricesDivergentRejected = false;
  try {
    await sendPrices({
      ...pricesCommand,
      quotations: pricesCommand.quotations.map((quotation) => ({ ...quotation, priceBrl: '2' })),
    });
  } catch (error) {
    pricesDivergentRejected = error instanceof Error && 'status' in error && error.status === 409;
  }
  if (JSON.stringify(prices) !== JSON.stringify(pricesReplay) || prices.visitId !== first.visitId ||
      prices.availability !== 'available' || prices.quotationIds.length !== 1) {
    throw new Error('Os preços não foram reconhecidos de forma canônica e idempotente.');
  }
  if (!pricesDivergentRejected) {
    throw new Error('O servidor não rejeitou os preços divergentes com a mesma chave.');
  }
  return {
    status: 'ok',
    visitId: first.visitId,
    visitStatus: first.status,
    checks: {
      started: true,
      replayMatched: true,
      divergentRejected: true,
      canonicalContext: true,
      stockSaved: true,
      stockReplayMatched: true,
      stockDivergentRejected: true,
      pricesSaved: true,
      pricesReplayMatched: true,
      pricesDivergentRejected: true,
    },
  };
}
