import { clientSalesPath, clientSalesQuerySchema, clientSalesResponseSchema, salesSignalsPath,
  salesSignalsQuerySchema, salesSignalsResponseSchema, type ClientSalesQuery, type SalesSignalsQuery } from '@cirne/contracts';
import { z } from 'zod';
import { safeSyncOrigin } from './client-sheet-sync';

export type SalesCrmCommand = { kind: 'client'; clientId: string; query: ClientSalesQuery }
  | { kind: 'signals'; query: SalesSignalsQuery };
export async function salesCrmCommand(baseUrl: string, token: string, command: SalesCrmCommand,
  transport: typeof fetch = fetch) {
  if (!token.trim()) throw new Error('Identidade de consulta obrigatória.');
  const fields = command.kind === 'client' ? clientSalesQuerySchema.parse(command.query) : salesSignalsQuerySchema.parse(command.query);
  const url = new URL(command.kind === 'client' ? clientSalesPath(z.uuid().parse(command.clientId)) : salesSignalsPath,
    safeSyncOrigin(baseUrl));
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) {
    url.searchParams.set(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  const response = await transport(url, { method: 'GET', redirect: 'error', cache: 'no-store',
    signal: AbortSignal.timeout(90_000), headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Consulta de vendas respondeu HTTP ${response.status}. Revalide acesso e geração.`);
  const body: unknown = await response.json();
  return command.kind === 'client' ? clientSalesResponseSchema.parse(body) : salesSignalsResponseSchema.parse(body);
}
