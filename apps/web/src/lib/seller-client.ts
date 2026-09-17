import {
  authSessionPath, mePath, meResponseSchema, myTodayRoutePath, routeTodayResponseSchema,
  reorderRouteExecutionRequestSchema, reorderRouteExecutionResultSchema, routeExecutionOrderPath,
  loginRequestSchema, type LoginRequest, type CanonicalRoute,
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
};

export function isSessionFailure(error: unknown) {
  return error instanceof SellerHttpError && (error.status === 401 || error.status === 403);
}
