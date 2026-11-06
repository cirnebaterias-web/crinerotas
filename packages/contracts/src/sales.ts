import { z } from 'zod';

export const salesSheetName = 'Vendas';
export const salesTimeZone = 'America/Sao_Paulo';
export const salesScheduledTime = '06:15';
export const salesParserVersion = 1;
export const maxSalesRows = 100_000;
export const maxSalesChunkRows = 1_000;
export const salesSyncPath = '/api/v1/sales-sync';
export const salesSyncRunsPath = `${salesSyncPath}/runs`;
export const salesRunPath = (id: string) => `${salesSyncRunsPath}/${encodeURIComponent(id)}`;
export const clientSalesPath = (id: string) => `/api/v1/clients/${encodeURIComponent(id)}/sales`;
export const salesSignalsPath = '/api/v1/management/sales-signals';

export const salesSheetHeaders = [
  'Destinatário', 'CNPJ/CPF', 'Endereço', 'Bairro', 'Cidade', 'UF', 'CEP', 'Tipo Cliente',
  'Num. Nota Fiscal', 'Data da Venda', 'CódigoSKU', 'Volume', 'Valor Total Moeda Local',
  'Vend', 'Nome do Vendedor', 'Tabela de Preços', 'DAV', 'Descrição do Item',
  'Grupo do Item', 'Subgrupo do Item', 'Custo Unitário', 'Custo Total',
  'Valor de Tabela do Item', 'Valor de Venda Unitário', 'Desconto Total no Item',
  'Forma de Pagamento', 'Data da Última Compra', 'Categoria', 'Marca / Fabricante',
  'Linha', 'Vendedor', 'Heliar Servicel', 'KG ', 'Devolução', 'Quantidade Geral',
  'Status', 'Nome fantasia', 'CHAVE UNICA',
] as const;

const uuid = z.uuid().transform((value) => value.toLowerCase());
export const salesHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
// Money stays exact on every transport. Aggregations may exceed a single line's numeric(12,2).
export const salesMoneySchema = z.string().regex(/^-?(?:0|[1-9]\d{0,17})\.\d{2}$/)
  .refine((value) => value !== '-0.00');
const lineMoney = z.string().regex(/^-?(?:0|[1-9]\d{0,9})\.\d{2}$/)
  .refine((value) => value !== '-0.00');
const textField = (max: number, required = true) => z.string().max(max)
  .refine((value) => value === value.trim() && (!required || value.length > 0))
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value))
  .refine((value) => !/^[=+@]/u.test(value));
export const salesProductSchema = z.object({
  sku: textField(80), productDescription: textField(240),
  itemGroup: textField(80), itemSubgroup: textField(80, false),
  category: textField(80, false), brand: textField(80, false), line: textField(80, false),
}).strict();
const transactionFields = {
  invoiceNumber: textField(80), saleDate: z.iso.date().refine((value) => value >= '1900-01-01'),
  kind: z.enum(['sale', 'return']), volume: z.number().int().min(-1_000_000).max(1_000_000),
  totalAmount: lineMoney,
} as const;
function consistentSigns(row: { kind: 'sale' | 'return'; volume: number; totalAmount: string }) {
  return row.kind === 'sale'
    ? row.volume > 0 && !row.totalAmount.startsWith('-')
    : row.volume < 0 && (row.totalAmount.startsWith('-') || row.totalAmount === '0.00');
}
export const salesImportRowSchema = salesProductSchema.extend({
  sourceRow: z.number().int().min(2).max(maxSalesRows + 1),
  externalKey: textField(256),
  clientExternalReference: z.string().regex(/^(?:\d{11}|\d{14})$/),
  ...transactionFields,
}).strict().refine(consistentSigns, { message: 'Sinais incompatíveis com a operação.' });
export const clientSalesLineSchema = salesProductSchema.extend(transactionFields).strict()
  .refine(consistentSigns, { message: 'Sinais incompatíveis com a operação.' });
export type SalesImportRow = z.infer<typeof salesImportRowSchema>;
export type SalesProduct = z.infer<typeof salesProductSchema>;
export type ClientSalesLine = z.infer<typeof clientSalesLineSchema>;

export const salesSyncRequestSchema = z.discriminatedUnion('trigger', [
  z.object({ trigger: z.literal('manual'), idempotencyKey: uuid }).strict(),
  z.object({ trigger: z.literal('scheduled') }).strict(),
]);
export const salesSyncResultSchema = z.object({
  id: uuid, sourceKey: salesHashSchema, status: z.enum(['collecting', 'published', 'failed']),
  trigger: z.enum(['manual', 'scheduled']),
  startedAt: z.iso.datetime({ offset: true }), completedAt: z.iso.datetime({ offset: true }).nullable(),
  generationId: uuid.nullable(), contentHash: salesHashSchema.nullable(),
  parserVersion: z.number().int().positive().nullable(),
  sourceRowCount: z.number().int().nonnegative().max(maxSalesRows),
  stagedRowCount: z.number().int().nonnegative().max(maxSalesRows),
  unmatchedClientCount: z.number().int().nonnegative().max(maxSalesRows), // Distinct documents with no client.
  issueCount: z.number().int().nonnegative().max(maxSalesRows), // Rows with missing client or no current seller scope at publication.
  observedMinDate: z.iso.date().nullable(), observedMaxDate: z.iso.date().nullable(),
  errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/).nullable(),
}).strict();
export const salesSyncBeginResultSchema = z.object({
  runId: uuid, leaseToken: uuid.nullable(), replayed: z.boolean(), result: salesSyncResultSchema,
}).strict();
export const salesSyncStageRequestSchema = z.object({
  leaseToken: uuid, chunkIndex: z.number().int().nonnegative().max(maxSalesRows - 1),
  chunkHash: salesHashSchema, rows: z.array(salesImportRowSchema).min(1).max(maxSalesChunkRows),
}).strict();
export const salesSyncStageResultSchema = z.object({
  stagedCount: z.number().int().nonnegative().max(maxSalesRows), replayed: z.boolean(),
}).strict();
export const salesSyncPublishRequestSchema = z.object({
  leaseToken: uuid, contentHash: salesHashSchema,
  expectedRowCount: z.number().int().positive().max(maxSalesRows), parserVersion: z.literal(salesParserVersion),
}).strict();
export const salesSyncFailRequestSchema = z.object({
  leaseToken: uuid, errorCode: z.enum([
    'SOURCE_UNAVAILABLE', 'SOURCE_INVALID', 'SOURCE_CHANGED', 'SOURCE_TOO_LARGE',
    'VALIDATION_FAILED', 'PERSISTENCE_FAILED', 'INTERRUPTED',
  ]),
}).strict();
export const salesSyncDatabaseStatusSchema = z.object({
  latestRun: salesSyncResultSchema.nullable(), lastPublishedRun: salesSyncResultSchema.nullable(),
}).strict();
export const salesSyncStatusSchema = salesSyncDatabaseStatusSchema.extend({
  configured: z.boolean(), reason: z.enum(['ready', 'disabled', 'missing_configuration', 'invalid_configuration']),
  scheduleEnabled: z.boolean(), timeZone: z.literal(salesTimeZone), time: z.literal(salesScheduledTime),
  lastSuccessAt: z.iso.datetime({ offset: true }).nullable(),
}).strict();
export type SalesSyncRequest = z.infer<typeof salesSyncRequestSchema>;
export type SalesSyncResult = z.infer<typeof salesSyncResultSchema>;
export type SalesSyncStatus = z.infer<typeof salesSyncStatusSchema>;

// Read models never include document numbers, external source keys, costs or another client's facts.
export const salesGenerationSchema = z.object({
  clientVersion: z.number().int().positive().max(2147483647),
  generationId: uuid, fetchedAt: z.iso.datetime({ offset: true }), publishedAt: z.iso.datetime({ offset: true }),
  observedFrom: z.iso.date(), observedThrough: z.iso.date(), asOfDate: z.iso.date(),
  client: z.object({ id: uuid, name: z.string().min(1).max(160) }).strict(),
}).strict();
export const clientSalesPageSchema = salesGenerationSchema.extend({
  rows: z.array(clientSalesLineSchema).max(1000), nextAfterRow: z.number().int().min(2).max(maxSalesRows + 1).nullable(),
}).strict();
export const clientSalesProductsPageSchema = z.object({
  generationId: uuid, asOfDate: z.iso.date(), clientVersion: salesGenerationSchema.shape.clientVersion,
  products: z.array(salesProductSchema).max(1000), nextAfterSku: textField(80).nullable(),
}).strict();
export type SalesGeneration = z.infer<typeof salesGenerationSchema>;
export type ClientSalesPage = z.infer<typeof clientSalesPageSchema>;

export function salesScheduledSlot(now: Date): string | null {
  if (!Number.isFinite(now.getTime())) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: salesTimeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map((part) => [part.type, part.value]));
  if (parts.hour !== '06' || Number(parts.minute) < 15) return null;
  return `${parts.year}-${parts.month}-${parts.day}@06:15`;
}
