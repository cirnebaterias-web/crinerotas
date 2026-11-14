import {
  authSessionPath, dailySellerLocationCaptureSchema, dailySellerLocationSchema, mePath, meResponseSchema,
  myTodayRoutePath, routeTodayResponseSchema,
  reorderRouteExecutionRequestSchema, reorderRouteExecutionResultSchema, routeExecutionOrderPath,
  loginRequestSchema, type LoginRequest, type CanonicalRoute,
  extendSellerRouteCommandSchema, extendSellerRouteResultSchema, extendSellerRoutePath,
  sellerRouteClientSearchResponseSchema, sellerRouteClientsPath,
  clientClassificationCatalogPath, clientClassificationCatalogSchema, clientFieldProfilePath,
  clientFieldProfileSchema, classifyClientCommandSchema, classifyClientResultSchema,
  closeClientCommandSchema, closeClientResultSchema, closeClientOperationsPath,
} from '@cirne/contracts';

export class SellerHttpError extends Error {
  constructor(public readonly status: number) { super('A operação não pôde ser concluída.'); }
}

async function request(path: string, init: RequestInit = {}) {
  const timeout = AbortSignal.timeout(15_000);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  const response = await fetch(path, { ...init, signal, credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) throw new SellerHttpError(response.status);
  return response.status === 204 ? null : response.json() as Promise<unknown>;
}

const mutationHeaders = { 'content-type': 'application/json', 'x-csrf-token': 'cirne-route-v1' };
function notifySessionChange() {
  const channel = new BroadcastChannel('cirne-session');
  channel.postMessage('changed');
  channel.close();
}

export const sellerClient = {
  async login(credentials: LoginRequest) {
    const identity = meResponseSchema.parse(await request(authSessionPath, {
      method: 'POST', headers: mutationHeaders, body: JSON.stringify(loginRequestSchema.parse(credentials)),
    }));
    notifySessionChange();
    return identity;
  },
  async logout() {
    try { await request(authSessionPath, { method: 'DELETE', headers: mutationHeaders }); }
    finally { notifySessionChange(); }
  },
  async identity(signal?: AbortSignal) { return meResponseSchema.parse(await request(mePath, { signal })); },
  async today(signal?: AbortSignal) { return routeTodayResponseSchema.parse(await request(myTodayRoutePath, { signal })); },
  async reorder(route: CanonicalRoute, pendingStopIds: string[]) {
    const body = reorderRouteExecutionRequestSchema.parse({ schemaVersion: 1, expectedVersion: route.executionVersion, pendingStopIds });
    return reorderRouteExecutionResultSchema.parse(await request(routeExecutionOrderPath(route.routeId), {
      method: 'PUT', headers: mutationHeaders, body: JSON.stringify(body),
    }));
  },
  async captureRouteLocation(input: { latitude: number; longitude: number; accuracyM: number; capturedAt: string }) {
    const body = dailySellerLocationCaptureSchema.parse({ schemaVersion: 1, idempotencyKey: crypto.randomUUID(), ...input });
    return dailySellerLocationSchema.parse(await request('/api/v1/me/route-location', {
      method: 'POST', headers: mutationHeaders, body: JSON.stringify(body),
    }));
  },
  async searchRouteClients(routeId: string, query: string, signal?: AbortSignal) {
    const params = new URLSearchParams({ routeId, q: query });
    return sellerRouteClientSearchResponseSchema.parse(await request(`${sellerRouteClientsPath}?${params}`, { signal }));
  },
  async addRouteClient(route: CanonicalRoute, clientId: string, deviceId: string, idempotencyKey: string) {
    const body = extendSellerRouteCommandSchema.parse({ schemaVersion: 1, routeId: route.routeId,
      expectedVersion: route.executionVersion, clientId });
    return extendSellerRouteResultSchema.parse(await request(extendSellerRoutePath(route.routeId), {
      method: 'POST', headers: { ...mutationHeaders, 'x-device-id': deviceId, 'idempotency-key': idempotencyKey },
      body: JSON.stringify(body),
    }));
  },
  async clientFieldProfile(clientId: string) {
    return clientFieldProfileSchema.parse(await request(clientFieldProfilePath(clientId)));
  },
  async classificationCatalog() {
    return clientClassificationCatalogSchema.parse(await request(clientClassificationCatalogPath));
  },
  async classifyClient(clientId: string, classificationCode: string, deviceId: string, idempotencyKey: string) {
    const body = classifyClientCommandSchema.parse({ schemaVersion: 1, clientId, classificationCode });
    return classifyClientResultSchema.parse(await request(clientFieldProfilePath(clientId), { method: 'POST',
      headers: { ...mutationHeaders, 'x-device-id': deviceId, 'idempotency-key': idempotencyKey }, body: JSON.stringify(body) }));
  },
  async closeClient(clientId: string, reason: string, observation: string, deviceId: string, idempotencyKey: string) {
    const body = closeClientCommandSchema.parse({ schemaVersion: 1, clientId, reason,
      ...(observation.trim() ? { observation } : {}) });
    return closeClientResultSchema.parse(await request(closeClientOperationsPath(clientId), { method: 'POST',
      headers: { ...mutationHeaders, 'x-device-id': deviceId, 'idempotency-key': idempotencyKey }, body: JSON.stringify(body) }));
  },
};

export function isSessionFailure(error: unknown) {
  return error instanceof SellerHttpError && (error.status === 401 || error.status === 403);
}
