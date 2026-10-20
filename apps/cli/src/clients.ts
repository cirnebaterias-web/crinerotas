import {
  clientDetailSchema,
  clientMutationResponseSchema,
  clientOpsResultSchema,
  clientPath,
  clientsPath,
  createClientRequestSchema,
  updateClientRequestSchema,
} from '@cirne/contracts';

type Requester = typeof fetch;

async function jsonRequest(
  request: Requester,
  baseUrl: string,
  path: string,
  token: string,
  init: RequestInit = {},
) {
  const response = await request(new URL(path, baseUrl), {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
    cache: 'no-store',
  });
  const body = await response.json() as unknown;
  return { response, body };
}
export async function runClientManagementRoundTrip(
  baseUrl: string,
  token: string,
  sellerEmail: string,
  request: Requester = fetch,
) {
  const externalReference = `CLI-${crypto.randomUUID()}`;
  const createKey = crypto.randomUUID();
  const createCommand = createClientRequestSchema.parse({
    schemaVersion: 1,
    externalReference,
    name: 'Cliente sintético CLI',
    address: 'Rua Sintética CLI, 10',
    latitude: null,
    longitude: null,
    portfolioReference: 'CLI',
    sellerEmail,
    status: 'active',
  });
  const firstExchange = await jsonRequest(request, baseUrl, clientsPath, token, {
    method: 'POST', headers: { 'Idempotency-Key': createKey }, body: JSON.stringify(createCommand),
  });
  if (!firstExchange.response.ok) throw new Error(`Criação respondeu HTTP ${firstExchange.response.status}.`);
  const first = clientMutationResponseSchema.parse(firstExchange.body);

  const replayExchange = await jsonRequest(request, baseUrl, clientsPath, token, {
    method: 'POST', headers: { 'Idempotency-Key': createKey }, body: JSON.stringify(createCommand),
  });
  if (!replayExchange.response.ok) throw new Error(`Replay respondeu HTTP ${replayExchange.response.status}.`);
  const replay = clientMutationResponseSchema.parse(replayExchange.body);
  if (!replay.replayed || replay.client.id !== first.client.id) {
    throw new Error('Reenvio idempotente não retornou o cliente canônico.');
  }

  const queryExchange = await jsonRequest(request, baseUrl, clientPath(first.client.id), token);
  if (!queryExchange.response.ok) throw new Error(`Consulta respondeu HTTP ${queryExchange.response.status}.`);
  const queried = clientDetailSchema.parse(queryExchange.body);

  const updateCommand = updateClientRequestSchema.parse({
    schemaVersion: 1,
    expectedVersion: queried.version,
    reason: 'Correção sintética do round-trip CLI',
    name: 'Cliente sintético CLI corrigido',
    address: queried.address,
    latitude: queried.latitude,
    longitude: queried.longitude,
    portfolioReference: queried.portfolioReference,
    sellerEmail,
    status: queried.status,
  });
  const updateExchange = await jsonRequest(request, baseUrl, clientPath(queried.id), token, {
    method: 'PATCH', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify(updateCommand),
  });
  if (!updateExchange.response.ok) throw new Error(`Correção respondeu HTTP ${updateExchange.response.status}.`);
  const updated = clientMutationResponseSchema.parse(updateExchange.body);

  const staleCommand = { ...updateCommand, name: 'Tentativa concorrente obsoleta' };
  const conflictExchange = await jsonRequest(request, baseUrl, clientPath(queried.id), token, {
    method: 'PATCH', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify(staleCommand),
  });
  if (conflictExchange.response.status !== 409) {
    throw new Error(`Conflito esperado respondeu HTTP ${conflictExchange.response.status}.`);
  }

  return clientOpsResultSchema.parse({
    schemaVersion: 1,
    status: 'ok',
    clientId: first.client.id,
    createdVersion: first.client.version,
    updatedVersion: updated.client.version,
    checks: {
      created: true,
      replayed: replay.replayed,
      queried: queried.id === first.client.id,
      updated: updated.client.name === updateCommand.name && updated.client.version > queried.version,
      staleConflict: true,
    },
  });
}
