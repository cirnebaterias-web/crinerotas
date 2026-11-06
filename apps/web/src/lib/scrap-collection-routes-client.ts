import {
  apiErrorResponseSchema, scrapCollectionRouteListSchema, scrapCollectionRouteSchema,
  scrapCollectionRouteOperationPath, scrapCollectionRoutesPath, type ScrapCollectionRoute,
} from '@cirne/contracts';

async function request(path: string, options?: RequestInit): Promise<unknown> {
  let response: Response;
  try { response = await fetch(path, { credentials: 'same-origin', cache: 'no-store',
    signal: AbortSignal.timeout(30_000), ...options }); }
  catch { throw new Error('A conexão não respondeu. Atualize a rota e tente novamente.'); }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = apiErrorResponseSchema.safeParse(body);
    if (response.status === 401) throw new Error('Sua sessão expirou. Entre novamente para continuar.');
    if (response.status === 403) throw new Error('Seu perfil não tem permissão para esta rota.');
    if (response.status === 409) throw new Error('A rota mudou. Atualize os dados antes de tentar novamente.');
    if (response.status === 422 && parsed.success) throw new Error(parsed.data.error.message);
    throw new Error('Não foi possível concluir a operação da rota.');
  }
  return body;
}

function read<T>(schema: { parse(value: unknown): T }, value: unknown) {
  try { return schema.parse(value); }
  catch { throw new Error('A resposta da rota está inconsistente. Atualize a página.'); }
}

function mutation(body: unknown, key: string): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': 'cirne-route-v1',
    'idempotency-key': key }, body: JSON.stringify(body) };
}

export const scrapCollectionRoutesClient = {
  async list(date: string) {
    return read(scrapCollectionRouteListSchema,
      await request(`${scrapCollectionRoutesPath}?date=${encodeURIComponent(date)}`));
  },
  async create(body: unknown, key: string) {
    return read(scrapCollectionRouteSchema, await request(scrapCollectionRoutesPath, mutation(body, key)));
  },
  async change(route: ScrapCollectionRoute, operation: 'revise' | 'reorder' | 'approve' | 'assign', body: unknown, key: string) {
    return read(scrapCollectionRouteSchema,
      await request(scrapCollectionRouteOperationPath(route.routeId, operation), mutation(body, key)));
  },
};
