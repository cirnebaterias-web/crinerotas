import { clientSalesQuerySchema, clientSalesResponseSchema, salesSignalBatchSchema,
  salesSignalsQuerySchema, salesSignalsResponseSchema,
  type ClientSalesQuery, type SalesSignalsQuery } from '@cirne/contracts';
import { calculateClientSales, clientSalesTopProducts, salesCrmContext, salesMetricsFromStats,
  type ClientCatalogProjection } from '@cirne/domain';
import type { SupabaseClient } from '@supabase/supabase-js';
import { RouteRequestError } from '../routes/http';
import { salesSyncRpc } from '../sales-sync/http';
import { readClientCatalogMatches, readClientCatalogOpportunities, readClientSalesCatalogContext,
  readClientSalesSnapshot } from './service';

const validation = () => new RouteRequestError(422, 'VALIDATION_FAILED', 'Parâmetros de consulta inválidos.', false);
const unavailable = () => new RouteRequestError(503, 'DEPENDENCY_UNAVAILABLE', 'Histórico de vendas temporariamente indisponível.', true);
const conflict = () => new RouteRequestError(409, 'VERSION_CONFLICT', 'O histórico ou a data de referência mudou. Recarregue a consulta.', true);

function queryFields(url: string) {
  const params = new URL(url).searchParams;
  if ([...params.keys()].some((key) => params.getAll(key).length !== 1)) throw validation();
  return Object.fromEntries(params);
}
export function parseClientSalesQuery(url: string): ClientSalesQuery {
  const parsed = clientSalesQuerySchema.safeParse(queryFields(url));
  if (!parsed.success) throw validation();
  return parsed.data;
}
export function parseSalesSignalsQuery(url: string): SalesSignalsQuery {
  const fields = queryFields(url);
  const parsed = salesSignalsQuerySchema.safeParse({ ...fields, clientIds: fields.clientIds?.split(',') });
  if (!parsed.success) throw validation();
  return parsed.data;
}
export async function getClientSales(client: SupabaseClient, id: string, query: ClientSalesQuery, now: Date) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const context = await readClientSalesCatalogContext(client, id, query);
      const snapshot = await readClientSalesSnapshot(client, id, context.salesGenerationId,
        context.asOfDate, context.clientVersion);
      if (snapshot.fetchedAt !== context.fetchedAt || snapshot.publishedAt !== context.publishedAt
          || snapshot.observedFrom !== context.observedFrom || snapshot.observedThrough !== context.observedThrough
          || snapshot.client.id !== context.client.id || snapshot.client.name !== context.client.name) throw conflict();
      let catalogProjection: ClientCatalogProjection;
      if (context.catalog.status === 'catalog_unavailable') {
        catalogProjection = { catalog: context.catalog, topMatches: [], opportunities: null };
      } else {
        const catalog = context.catalog;
          const pinned = { salesGenerationId: context.salesGenerationId,
            catalogGenerationId: catalog.generationId, asOfDate: context.asOfDate,
            clientVersion: context.clientVersion };
          const topCodes = clientSalesTopProducts(snapshot.rows, context.asOfDate).map((product) => product.sku);
          const [topMatches, opportunities] = await Promise.all([
            readClientCatalogMatches(client, id, pinned, topCodes),
            readClientCatalogOpportunities(client, id, pinned, query.opportunityPage),
          ]);
        catalogProjection = { catalog, topMatches, opportunities };
      }
      return clientSalesResponseSchema.parse(calculateClientSales({
        generationId: snapshot.generationId, fetchedAt: snapshot.fetchedAt, publishedAt: snapshot.publishedAt,
        observedFrom: snapshot.observedFrom, observedThrough: snapshot.observedThrough, asOfDate: snapshot.asOfDate,
        client: snapshot.client, clientVersion: snapshot.clientVersion, rows: snapshot.rows,
      }, query, now, catalogProjection));
    } catch (error) {
      if (error instanceof RangeError) throw validation();
      if (!query.salesGenerationId && attempt === 0 && error instanceof RouteRequestError
          && error.code === 'VERSION_CONFLICT') continue;
      if (error instanceof RouteRequestError) throw error;
      throw unavailable();
    }
  }
  throw conflict();
}
export async function getSalesSignals(client: SupabaseClient, query: SalesSignalsQuery, now: Date) {
  const parsed = salesSignalBatchSchema.safeParse(await salesSyncRpc(client, 'get_sales_route_signals', {
    p_seller_id: query.sellerId, p_client_ids: query.clientIds, p_snapshot_id: query.generationId ?? null,
  }));
  if (!parsed.success) throw unavailable();
  const { signals, sellerId, ...metadata } = parsed.data;
  if ((query.generationId && metadata.generationId !== query.generationId)
      || (query.asOfDate && metadata.asOfDate !== query.asOfDate)) throw conflict();
  const requested = new Set(query.clientIds);
  if (sellerId !== query.sellerId || signals.length !== requested.size
      || new Set(signals.map((signal) => signal.client.id)).size !== requested.size
      || signals.some((signal) => !requested.has(signal.client.id))) throw unavailable();
  try {
    return salesSignalsResponseSchema.parse({ schemaVersion: 1, ...salesCrmContext(metadata, now),
      sellerId, serviceDate: query.serviceDate,
      signals: signals.map(({ client: customer, ...stats }) => ({ client: customer,
        metrics: salesMetricsFromStats(stats, metadata.asOfDate) })) });
  } catch { throw unavailable(); }
}
