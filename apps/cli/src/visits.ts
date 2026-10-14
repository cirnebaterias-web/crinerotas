import { createHash } from 'node:crypto';
import {
  apiErrorResponseSchema,
  competitorPriceParameterSetSchema,
  competitorPricesResultSchema,
  commercialActionListSchema,
  commercialActionsPath,
  createPickupScheduleRequestSchema,
  currentParameterSetPath,
  myTodayRoutePath,
  routeTodayResponseSchema,
  saveCompetitorPricesRequestSchema,
  saveVisitCommercialActionsRequestSchema,
  pickupScheduleSchema,
  scrapSchedulesPath,
  scrapCollectionsPath,
  scrapCollectionReceiptPath,
  scrapAttachmentUploadIntentsPath,
  scrapAttachmentConfirmPath,
  scrapAttachmentUploadIntentRequestSchema,
  scrapAttachmentUploadIntentResultSchema,
  attachmentConfirmationSchema,
  confirmScrapReceiptRequestSchema,
  scrapReceiptSchema,
  scrapCollectionSchema,
  scrapOperationsSchema,
  startVisitRequestSchema,
  saveStockRequestSchema,
  stockSnapshotResultSchema,
  visitCompetitorPricesPath,
  visitStockPath,
  visitStartResultSchema,
  visitsPath,
  syncBatchPath,
  syncBatchResponseSchema,
  syncCommandSchema,
  type SyncCommand,
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
    commercialActionsSaved: true;
    commercialActionsReplayMatched: true;
    commercialActionsDivergentRejected: true;
    scrapSaved: true;
    scrapReplayMatched: true;
    scrapDivergentRejected: true;
    standaloneScheduleSaved: true;
    standaloneScheduleReplayMatched: true;
    standaloneScheduleDivergentRejected: true;
  };
  custody?: {
    collectionId: string;
    actualWeightKg: '100';
    receivedWeightKg: '98';
    termVerified: true;
    unverifiedReceiptRejected: true;
    receiptReplayMatched: true;
    receiptDivergentRejected: true;
  };
}

export interface VisitRoundTripOptions {
  scrapMode: 'collected';
  logisticsAccessToken: string;
}

export async function runVisitRoundTrip(
  baseUrl: string,
  sellerAccessToken: string,
  request: typeof fetch = fetch,
  options?: VisitRoundTripOptions,
): Promise<VisitRoundTripResult> {
  if (!sellerAccessToken.trim()) throw new Error('Token de Vendedor obrigatório.');
  const origin = parseLocalOrigin(baseUrl);
  const seller = await checkIdentity(baseUrl, sellerAccessToken, request);
  if (!seller.roles.includes('seller') || !seller.capabilities.includes('visit.start_self') ||
      !seller.capabilities.includes('scrap.collect_self') || !seller.capabilities.includes('scrap.schedule_self')) {
    throw new Error('O token não pertence a um Vendedor autorizado a iniciar visitas.');
  }
  if (options) {
    const logistics = await checkIdentity(baseUrl, options.logisticsAccessToken, request);
    if (!logistics.roles.includes('logistics') || !logistics.capabilities.includes('scrap.receive')) {
      throw new Error('O token de Logística não pode confirmar recebimento de sucata.');
    }
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
  const actionCatalog = commercialActionListSchema.parse(await requestJson(
    origin, commercialActionsPath, sellerAccessToken, { method: 'GET' }, request,
  ));
  const actionEventId = crypto.randomUUID();
  const actionKey = crypto.randomUUID();
  const actionSavedAt = new Date().toISOString();
  const actionPayload = saveVisitCommercialActionsRequestSchema.parse({
    schemaVersion: 1,
    offlineId: command.offlineId,
    deviceSavedAt: actionSavedAt,
    ownAcknowledgements: actionCatalog.actions.map((action) => ({
      actionId: action.id, title: action.title, validFrom: action.validFrom,
      validUntil: action.validUntil, presented: true,
    })),
    competitor: { availability: 'not_identified' },
  });
  const actionEvent = {
    eventId: actionEventId,
    idempotencyKey: actionKey,
    operation: 'visit.commercial-actions.saved.v1' as const,
    schemaVersion: 1 as const,
    sequence: 4,
    aggregateType: 'visit' as const,
    aggregateId: command.offlineId,
    occurredAt: actionSavedAt,
    payload: {
      offlineId: actionPayload.offlineId,
      deviceSavedAt: actionPayload.deviceSavedAt,
      ownAcknowledgements: actionPayload.ownAcknowledgements,
      competitor: actionPayload.competitor,
    },
  };
  const sendActions = (event: typeof actionEvent) => requestJson(
    origin, syncBatchPath, sellerAccessToken,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId, events: [event] }) },
    request,
  );
  const actionResult = syncBatchResponseSchema.parse(await sendActions(actionEvent));
  const actionReplay = syncBatchResponseSchema.parse(await sendActions(actionEvent));
  const divergentEvent = {
    ...actionEvent,
    payload: {
      ...actionEvent.payload,
      ownAcknowledgements: actionEvent.payload.ownAcknowledgements.map((action) => ({
        ...action, title: `${action.title} divergente`,
      })),
    },
  };
  const actionDivergent = syncBatchResponseSchema.parse(await sendActions(divergentEvent));
  if (actionResult.results[0]?.status !== 'confirmed' ||
      JSON.stringify(actionResult.results[0]) !== JSON.stringify(actionReplay.results[0])) {
    const firstStatus = actionResult.results[0]?.status ?? 'ausente';
    const firstCode = actionResult.results[0]?.status === 'rejected' || actionResult.results[0]?.status === 'recoverable_error'
      ? actionResult.results[0].error.code : 'sem_codigo';
    throw new Error(`As ações comerciais não foram reconhecidas de forma canônica e idempotente (${firstStatus}:${firstCode}).`);
  }
  if (actionDivergent.results[0]?.status !== 'rejected' ||
      actionDivergent.results[0].error.code !== 'IDEMPOTENCY_KEY_REUSED') {
    throw new Error('O servidor não rejeitou ações comerciais divergentes com a mesma chave.');
  }
  const scrapSavedAt = new Date().toISOString();
  const collectionOfflineId = crypto.randomUUID();
  const photoOfflineId = crypto.randomUUID();
  const scrapPayload = options ? {
    schemaVersion: 1, offlineId: command.offlineId, deviceSavedAt: scrapSavedAt,
    availability: 'collected', collection: {
      offlineId: collectionOfflineId, actualWeightKg: '100', collectedAt: scrapSavedAt,
      receiptNumber: `SYN-${collectionOfflineId.slice(0, 8)}`, clientSigned: true,
      sellerSigned: true, twoCopies: true, destinationType: 'headquarters',
      attachmentOfflineIds: [photoOfflineId],
    },
  } : {
    schemaVersion: 1, offlineId: command.offlineId, deviceSavedAt: scrapSavedAt, availability: 'none',
  };
  const scrapEvent = syncCommandSchema.parse({
    eventId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(),
    operation: 'visit.scrap.saved.v1', schemaVersion: 1,
    sequence: 5, aggregateType: 'visit', aggregateId: command.offlineId,
    occurredAt: scrapSavedAt,
    payload: scrapPayload,
  });
  const sendScrap = (event: SyncCommand) => requestJson(origin, syncBatchPath, sellerAccessToken, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId, events: [event] }),
  }, request);
  const scrapResult = syncBatchResponseSchema.parse(await sendScrap(scrapEvent));
  const scrapReplay = syncBatchResponseSchema.parse(await sendScrap(scrapEvent));
  const divergentAt = new Date(Date.parse(scrapSavedAt) + 1_000).toISOString();
  const scrapDivergent = syncBatchResponseSchema.parse(await sendScrap(syncCommandSchema.parse({
    ...scrapEvent, occurredAt: divergentAt,
    payload: { ...scrapEvent.payload, deviceSavedAt: divergentAt },
  })));
  if (scrapResult.results[0]?.status !== 'confirmed' ||
      JSON.stringify(scrapResult.results[0]) !== JSON.stringify(scrapReplay.results[0])) {
    throw new Error('A resposta de sucata não foi confirmada de forma idempotente.');
  }
  if (scrapDivergent.results[0]?.status !== 'rejected' ||
      scrapDivergent.results[0].error.code !== 'IDEMPOTENCY_KEY_REUSED') {
    throw new Error('O servidor não rejeitou sucata divergente com a mesma chave.');
  }
  const scheduleKey = crypto.randomUUID();
  const scheduleCommand = createPickupScheduleRequestSchema.parse({
    schemaVersion: 1, offlineId: crypto.randomUUID(), clientId: stop.client.id,
    estimatedWeightKg: '10',
    desiredDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString().slice(0, 10),
    period: 'morning', observation: 'Diagnóstico sintético do agendamento avulso.',
    requestedAt: new Date().toISOString(),
  });
  const sendSchedule = (body: unknown) => requestJson(origin, scrapSchedulesPath, sellerAccessToken, {
    method: 'POST', headers: { 'Content-Type': 'application/json',
      'X-Device-Id': deviceId, 'Idempotency-Key': scheduleKey },
    body: JSON.stringify(body),
  }, request);
  const schedule = pickupScheduleSchema.parse(await sendSchedule(scheduleCommand));
  const scheduleReplay = pickupScheduleSchema.parse(await sendSchedule(scheduleCommand));
  let scheduleDivergentRejected = false;
  try { await sendSchedule({ ...scheduleCommand, estimatedWeightKg: '11' }); }
  catch (error) { scheduleDivergentRejected = error instanceof Error && 'status' in error && error.status === 409; }
  if (schedule.offlineId !== scheduleCommand.offlineId || schedule.origin !== 'standalone' ||
      schedule.status !== 'pending' || JSON.stringify(schedule) !== JSON.stringify(scheduleReplay) ||
      !scheduleDivergentRejected) {
    throw new Error('Agendamento avulso não foi reconhecido de forma canônica e idempotente.');
  }
  let custody: VisitRoundTripResult['custody'];
  if (options) {
    const sellerCollections = scrapOperationsSchema.omit({ schedules: true }).parse(await requestJson(
      origin, scrapCollectionsPath, sellerAccessToken, { method: 'GET' }, request,
    ));
    const collection = scrapCollectionSchema.parse(sellerCollections.collections.find(
      (item) => item.offlineId === collectionOfflineId,
    ));
    if (collection.actualWeightKg !== '100' || collection.status !== 'awaiting_receipt' ||
        !collection.attachmentOfflineIds.includes(photoOfflineId)) {
      throw new Error('A coleta sintética não apareceu no painel com o peso e comprovante esperados.');
    }

    const receiptKey = crypto.randomUUID();
    const receiptCommand = confirmScrapReceiptRequestSchema.parse({
      schemaVersion: 1, expectedVersion: collection.version, receivedWeightKg: '98',
      receivedLocation: 'Matriz sintética',
      observation: 'Diferença de 2 kg conferida no teste sintético.',
    });
    const sendReceipt = (body: unknown) => requestJson(
      origin, scrapCollectionReceiptPath(collection.id), options.logisticsAccessToken,
      { method: 'POST', headers: {
        'Content-Type': 'application/json', 'Idempotency-Key': receiptKey,
      }, body: JSON.stringify(body) }, request,
    );
    let unverifiedReceiptRejected = false;
    try { await sendReceipt(receiptCommand); }
    catch (error) { unverifiedReceiptRejected = error instanceof Error && 'status' in error && error.status === 422; }
    if (!unverifiedReceiptRejected) {
      throw new Error('A Logística conseguiu receber uma coleta sem comprovante verificado.');
    }

    // Bytes sintéticos apenas para validar assinatura, integridade e armazenamento privado.
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const checksum = createHash('sha256').update(jpeg).digest('hex');
    const photoCommand = scrapAttachmentUploadIntentRequestSchema.parse({
      schemaVersion: 1, offlineId: photoOfflineId, collectionOfflineId,
      contentType: 'image/jpeg', byteSize: jpeg.byteLength, checksum, capturedAt: scrapSavedAt,
    });
    const intent = scrapAttachmentUploadIntentResultSchema.parse(await requestJson(
      origin, scrapAttachmentUploadIntentsPath, sellerAccessToken,
      { method: 'POST', headers: {
        'Content-Type': 'application/json', 'Idempotency-Key': photoOfflineId,
        'X-Device-Id': deviceId,
      }, body: JSON.stringify(photoCommand) }, request,
    ));
    if (!intent.alreadyVerified) {
      const url = new URL(intent.signedUrl);
      if (!url.searchParams.has('token')) url.searchParams.set('token', intent.token);
      const upload = new FormData();
      upload.append('cacheControl', '3600');
      upload.append('', new Blob([jpeg], { type: 'image/jpeg' }));
      let uploadResponse: Response;
      try {
        uploadResponse = await request(url, {
          method: 'PUT', headers: { 'x-upsert': 'false' }, body: upload,
          redirect: 'error', signal: AbortSignal.timeout(60_000),
        });
      } catch { throw new Error('Upload do comprovante sintético indisponível.'); }
      if (!uploadResponse.ok && uploadResponse.status !== 409) {
        throw new Error(`Upload do comprovante sintético retornou HTTP ${uploadResponse.status}.`);
      }
    }
    const confirmation = attachmentConfirmationSchema.parse(await requestJson(
      origin, scrapAttachmentConfirmPath(photoOfflineId), sellerAccessToken,
      { method: 'POST', headers: {
        'Content-Type': 'application/json', 'Idempotency-Key': photoOfflineId,
        'X-Device-Id': deviceId,
      }, body: JSON.stringify({ schemaVersion: 1, checksum }) }, request,
    ));
    if (confirmation.offlineId !== photoOfflineId || confirmation.status !== 'verified') {
      throw new Error('O comprovante sintético não foi verificado.');
    }

    const receipt = scrapReceiptSchema.parse(await sendReceipt(receiptCommand));
    const receiptReplay = scrapReceiptSchema.parse(await sendReceipt(receiptCommand));
    let receiptDivergentRejected = false;
    try { await sendReceipt({ ...receiptCommand, receivedWeightKg: '99' }); }
    catch (error) { receiptDivergentRejected = error instanceof Error && 'status' in error && error.status === 409; }
    const logisticsCollections = scrapOperationsSchema.omit({ schedules: true }).parse(await requestJson(
      origin, scrapCollectionsPath, options.logisticsAccessToken, { method: 'GET' }, request,
    ));
    const received = scrapCollectionSchema.parse(logisticsCollections.collections.find(
      (item) => item.id === collection.id,
    ));
    if (receipt.collectionId !== collection.id || receipt.receivedWeightKg !== '98' ||
        JSON.stringify(receipt) !== JSON.stringify(receiptReplay) ||
        !receiptDivergentRejected || received.status !== 'received' ||
        received.receipt?.receivedWeightKg !== '98' ||
        !received.attachments.some((attachment) =>
          attachment.offlineId === photoOfflineId && attachment.status === 'verified')) {
      throw new Error('O recebimento pela Logística não fechou a cadeia de custódia sintética.');
    }
    custody = {
      collectionId: collection.id, actualWeightKg: '100', receivedWeightKg: '98',
      termVerified: true, unverifiedReceiptRejected: true,
      receiptReplayMatched: true, receiptDivergentRejected: true,
    };
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
      commercialActionsSaved: true,
      commercialActionsReplayMatched: true,
      commercialActionsDivergentRejected: true,
      scrapSaved: true,
      scrapReplayMatched: true,
      scrapDivergentRejected: true,
      standaloneScheduleSaved: true,
      standaloneScheduleReplayMatched: true,
      standaloneScheduleDivergentRejected: true,
    },
    ...(custody ? { custody } : {}),
  };
}
