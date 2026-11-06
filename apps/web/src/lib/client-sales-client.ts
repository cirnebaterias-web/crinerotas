import {
  clientSalesPath, clientSalesResponseSchema, salesSignalsPath, salesSignalsResponseSchema,
  type ClientSalesQuery, type SalesSignalsQuery,
} from '@cirne/contracts';

type SalesReadBase = { salesGenerationId: string; asOfDate: string; clientVersion: number };
export type SalesReadContext = SalesReadBase & (
  { catalogState: 'available'; catalogGenerationId: string }
  | { catalogState: 'catalog_unavailable'; catalogGenerationId?: never }
);

export class ClientSalesHttpError extends Error {
  constructor(public readonly status: number, public readonly reason?: string) {
    super('Não foi possível consultar o histórico comercial.');
  }
}

async function request(path: string, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(15_000);
  const response = await fetch(path, {
    credentials: 'same-origin', cache: 'no-store',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new ClientSalesHttpError(response.status,
      body?.error?.details?.reason === 'no_published_generation' ? 'no_published_generation' : undefined);
  }
  return response.json() as Promise<unknown>;
}

export const clientSalesClient = {
  async detail(clientId: string, query: Partial<ClientSalesQuery> = {}, signal?: AbortSignal) {
    const parameters = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined) parameters.set(key, String(value));
    return clientSalesResponseSchema.parse(await request(`${clientSalesPath(clientId)}?${parameters}`, signal));
  },
  async signals(query: SalesSignalsQuery, signal?: AbortSignal) {
    const parameters = new URLSearchParams({ sellerId: query.sellerId, serviceDate: query.serviceDate,
      clientIds: query.clientIds.join(',') });
    if (query.generationId && query.asOfDate) {
      parameters.set('generationId', query.generationId); parameters.set('asOfDate', query.asOfDate);
    }
    return salesSignalsResponseSchema.parse(await request(`${salesSignalsPath}?${parameters}`, signal));
  },
};

export function salesErrorMessage(error: unknown) {
  if (error instanceof ClientSalesHttpError) {
    if (error.status === 401 || error.status === 403 || error.status === 404) return 'Acesso ao histórico indisponível. Valide novamente sua autorização para este cliente.';
    if (error.status === 409) return 'A referência do histórico mudou. Atualize a consulta para usar uma única geração e data.';
    if (error.reason === 'no_published_generation') return 'Histórico ainda não disponibilizado.';
    if (error.status === 503) return 'Fonte do histórico indisponível. Tente novamente mais tarde.';
  }
  return 'Não foi possível consultar o histórico. Confira a conexão e tente novamente.';
}
