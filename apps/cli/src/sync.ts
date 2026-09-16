import {
  apiErrorResponseSchema,
  syncBatchExchangeSchema,
  syncBatchPath,
  type SyncBatchRequest,
} from '@cirne/contracts';

export function parseLocalOrigin(baseUrl: string) {
  try {
    const url = new URL(baseUrl);
    const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
    if (!['http:', 'https:'].includes(url.protocol) || !loopbackHosts.has(url.hostname) ||
        url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
    return url;
  } catch {
    throw new Error('URL inválida: informe uma origem local HTTP(S), sem credenciais ou parâmetros.');
  }
}

async function send(
  baseUrl: URL,
  token: string,
  batch: SyncBatchRequest,
  request: typeof fetch,
) {
  let response: Response;
  try {
    response = await request(new URL(syncBatchPath, baseUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(batch),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('URL inválida:')) throw error;
    throw new Error('Aplicação inacessível ou timeout durante a sincronização.');
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error('Resposta de sincronização incompatível com o contrato.');
  }
  if (!response.ok) {
    const parsed = apiErrorResponseSchema.safeParse(body);
    throw new Error(parsed.success
      ? `${parsed.data.error.message} (HTTP ${response.status}).`
      : `Sincronização retornou HTTP ${response.status}.`);
  }
  const parsed = syncBatchExchangeSchema.safeParse({ request: batch, response: body });
  if (!parsed.success) throw new Error('Resposta de sincronização incompatível com o contrato.');
  return parsed.data.response;
}

export interface SyncRoundTripResult {
  status: 'ok';
  checks: {
    firstConfirmation: true;
    replayMatched: true;
    divergentRejected: true;
  };
}

export async function runSyncRoundTrip(
  baseUrl: string,
  token: string,
  request: typeof fetch = fetch,
): Promise<SyncRoundTripResult> {
  if (!token.trim()) throw new Error('Token ausente. Use stdin ou CIRNE_ACCESS_TOKEN.');
  const origin = parseLocalOrigin(baseUrl);
  const deviceId = crypto.randomUUID();
  const aggregateId = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const idempotencyKey = crypto.randomUUID();
  const command = {
    eventId,
    idempotencyKey,
    operation: 'visit.draft.saved' as const,
    schemaVersion: 1 as const,
    sequence: 1,
    aggregateType: 'visit_draft' as const,
    aggregateId,
    occurredAt: new Date().toISOString(),
    payload: {
      draftOfflineId: aggregateId,
      routeVersionStopId: '44444444-4444-4444-8444-444444444441',
      acknowledged: true,
    },
  };
  const first = await send(origin, token, { deviceId, events: [command] }, request);
  const replay = await send(origin, token, { deviceId, events: [command] }, request);
  const divergent = await send(origin, token, {
    deviceId,
    events: [{ ...command, payload: { ...command.payload, acknowledged: false } }],
  }, request);

  const firstResult = first.results[0];
  const replayResult = replay.results[0];
  const divergentResult = divergent.results[0];
  if (firstResult?.status !== 'confirmed') throw new Error('A primeira sincronização não foi confirmada.');
  if (replayResult?.status !== 'confirmed' || JSON.stringify(replayResult) !== JSON.stringify(firstResult)) {
    throw new Error('A repetição idempotente não retornou a confirmação canônica original.');
  }
  if (divergentResult?.status !== 'rejected' || divergentResult.error.code !== 'IDEMPOTENCY_KEY_REUSED') {
    throw new Error('O servidor não rejeitou a chave idempotente com conteúdo divergente.');
  }

  return {
    status: 'ok',
    checks: { firstConfirmation: true, replayMatched: true, divergentRejected: true },
  };
}
