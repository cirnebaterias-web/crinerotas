import {
  catalogOpportunityRpcSchema, clientSalesCatalogContextSchema, clientSalesPageSchema,
  clientSalesProductsPageSchema, maxSalesRows, productCatalogMatchesRpcSchema, salesGenerationSchema,
  type ClientSalesLine, type ClientSalesQuery, type ProductCatalogItem, type SalesGeneration, type SalesProduct,
} from '@cirne/contracts';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireClientId } from '../clients/service';
import { RouteRequestError } from '../routes/http';
import { salesSyncRpc } from '../sales-sync/http';
import { productCatalogRpc } from '../product-catalog-sync/http';

export type ClientSalesSnapshot = SalesGeneration & { rows: ClientSalesLine[]; products: SalesProduct[] };
const changed = () => new RouteRequestError(409, 'VERSION_CONFLICT',
  'O histórico foi atualizado durante a consulta. Carregue o cliente novamente.', true);
const invalid = () => new RouteRequestError(503, 'DEPENDENCY_UNAVAILABLE',
  'Não foi possível carregar uma versão completa do histórico de vendas.', true);

/** No cache: every page and retry is evaluated under the current caller's database identity. */
export async function readClientSalesSnapshot(client: SupabaseClient, clientId: string,
  expectedGenerationId?: string, expectedAsOfDate?: string, expectedClientVersion?: number): Promise<ClientSalesSnapshot> {
  const id = requireClientId(clientId).toLowerCase();
  const expected = expectedGenerationId === undefined ? undefined : requireClientId(expectedGenerationId).toLowerCase();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await readComplete(client, id, expected, expectedAsOfDate, expectedClientVersion);
    } catch (error) {
      // A caller already paging a generation must restart explicitly, never continue into a new one.
      if (!expected && attempt === 0 && error instanceof RouteRequestError
          && error.code === 'VERSION_CONFLICT') continue;
      throw error;
    }
  }
  throw changed();
}

export async function readClientSalesCatalogContext(client: SupabaseClient, clientId: string, query: ClientSalesQuery) {
  const id = requireClientId(clientId).toLowerCase();
  const parsed = clientSalesCatalogContextSchema.safeParse(await productCatalogRpc(client,
    'get_client_sales_catalog_context', {
      p_client_id: id,
      p_sales_snapshot_id: query.salesGenerationId ?? null,
      p_catalog_snapshot_id: query.catalogGenerationId ?? null,
      p_catalog_state: query.catalogState ?? null,
      p_as_of_date: query.asOfDate ?? null,
      p_client_version: query.clientVersion ?? null,
    }));
  if (!parsed.success || parsed.data.client.id !== id) throw invalid();
  return parsed.data;
}

function samePinnedContext(value: { salesGenerationId: string; catalogGenerationId: string;
  asOfDate: string; clientVersion: number }, expected: { salesGenerationId: string;
  catalogGenerationId: string; asOfDate: string; clientVersion: number }) {
  if (value.salesGenerationId !== expected.salesGenerationId
      || value.catalogGenerationId !== expected.catalogGenerationId
      || value.asOfDate !== expected.asOfDate || value.clientVersion !== expected.clientVersion) throw changed();
}

export async function readClientCatalogMatches(client: SupabaseClient, clientId: string,
  context: { salesGenerationId: string; catalogGenerationId: string; asOfDate: string; clientVersion: number },
  factoryCodes: string[]): Promise<ProductCatalogItem[]> {
  if (!factoryCodes.length) return [];
  const parsed = productCatalogMatchesRpcSchema.safeParse(await productCatalogRpc(client,
    'get_client_product_catalog_matches', {
      p_client_id: requireClientId(clientId).toLowerCase(),
      p_sales_snapshot_id: context.salesGenerationId,
      p_catalog_snapshot_id: context.catalogGenerationId,
      p_as_of_date: context.asOfDate,
      p_client_version: context.clientVersion,
      p_factory_codes: factoryCodes,
    }));
  if (!parsed.success) throw invalid();
  samePinnedContext(parsed.data, context);
  const requested = new Set(factoryCodes);
  if (new Set(parsed.data.products.map((item) => item.factoryCode)).size !== parsed.data.products.length
      || parsed.data.products.some((item) => !requested.has(item.factoryCode))) throw invalid();
  return parsed.data.products;
}

export async function readClientCatalogOpportunities(client: SupabaseClient, clientId: string,
  context: { salesGenerationId: string; catalogGenerationId: string; asOfDate: string; clientVersion: number },
  page: number) {
  const parsed = catalogOpportunityRpcSchema.safeParse(await productCatalogRpc(client,
    'get_client_product_opportunities', {
      p_client_id: requireClientId(clientId).toLowerCase(),
      p_sales_snapshot_id: context.salesGenerationId,
      p_catalog_snapshot_id: context.catalogGenerationId,
      p_as_of_date: context.asOfDate,
      p_client_version: context.clientVersion,
      p_page: page,
    }));
  if (!parsed.success) throw invalid();
  samePinnedContext(parsed.data, context);
  return { availability: parsed.data.availability, page: parsed.data.page, pageSize: parsed.data.pageSize,
    totalCount: parsed.data.totalCount, totalPages: parsed.data.totalPages,
    coverage: parsed.data.coverage, products: parsed.data.products };
}

async function readComplete(client: SupabaseClient, clientId: string,
  expected?: string, expectedAsOfDate?: string, expectedClientVersion?: number): Promise<ClientSalesSnapshot> {
  let generation: SalesGeneration | undefined;
  const rows: ClientSalesLine[] = [];
  let afterRow = 0;
  for (let pages = 0; pages <= maxSalesRows; pages++) {
    const parsed = clientSalesPageSchema.safeParse(await salesSyncRpc(client, 'get_client_sales_page', {
      p_client_id: clientId, p_snapshot_id: generation?.generationId ?? expected ?? null, p_after_row: afterRow,
    }));
    if (!parsed.success) throw invalid();
    const page = parsed.data;
    const metadata = salesGenerationSchema.parse({
      generationId: page.generationId, fetchedAt: page.fetchedAt, publishedAt: page.publishedAt,
      observedFrom: page.observedFrom, observedThrough: page.observedThrough,
      asOfDate: page.asOfDate, client: page.client, clientVersion: page.clientVersion,
    });
    if (page.client.id !== clientId) throw invalid();
    if ((expected && page.generationId !== expected) || (expectedAsOfDate && page.asOfDate !== expectedAsOfDate)
        || (expectedClientVersion !== undefined && page.clientVersion !== expectedClientVersion)
        || (generation && JSON.stringify(metadata) !== JSON.stringify(generation))) throw changed();
    generation ??= metadata;
    rows.push(...page.rows);
    if (rows.length > maxSalesRows) throw invalid();
    if (page.nextAfterRow === null) break;
    if (page.rows.length === 0 || page.nextAfterRow <= afterRow || pages === maxSalesRows) throw invalid();
    afterRow = page.nextAfterRow;
  }
  if (!generation) throw invalid();
  const products: SalesProduct[] = [];
  const seen = new Set<string>();
  let afterSku: string | null = null;
  for (let pages = 0; pages <= maxSalesRows; pages++) {
    const parsed = clientSalesProductsPageSchema.safeParse(await salesSyncRpc(client, 'get_client_sales_products', {
      p_client_id: clientId, p_snapshot_id: generation.generationId, p_after_sku: afterSku,
    }));
    if (!parsed.success) throw invalid();
    const page = parsed.data;
    if (page.generationId !== generation.generationId || page.asOfDate !== generation.asOfDate
        || page.clientVersion !== generation.clientVersion) throw changed();
    for (const product of page.products) {
      if (seen.has(product.sku)) throw invalid();
      seen.add(product.sku);
      products.push(product);
    }
    if (products.length > maxSalesRows) throw invalid();
    if (page.nextAfterSku === null) break;
    // PostgreSQL's ordering/collation is authoritative; detect loops without JS locale comparisons.
    if (!page.products.length || page.nextAfterSku === afterSku || pages === maxSalesRows
        || page.nextAfterSku !== page.products.at(-1)?.sku) throw invalid();
    afterSku = page.nextAfterSku;
  }
  return { ...generation, rows, products };
}
