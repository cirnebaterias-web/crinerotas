import { z } from 'zod';

export const scrapLedgerTimeZone = 'America/Sao_Paulo';
export const scrapLedgerScheduledTimes = ['08:00', '18:00'] as const;
export const scrapLedgerParserVersion = 1;
export const maxScrapLedgerRows = 30_000;
export const scrapLedgerSyncPath = '/api/v1/scrap-ledger-sync';
export const scrapLedgerAnalyticsPath = '/api/v1/management/scrap-ledger';
export const clientScrapLedgerPath = (id: string) => `/api/v1/clients/${encodeURIComponent(id)}/scrap-ledger`;
export const scrapLedgerHeaders = ['Seq','Operação','CNPJ/CPF','Cliente','Cidade','Vendedor','NFe','Data','Peso','Preço','Total','Situacao','Forma Quitação','Duplicata','T. Compromisso','T. Quitação','Observação','Peso kg','Vendedor Carteira','Nome Fantasia','Cidade','Grupo empresarial','Situação cliente'] as const;
export const scrapBalanceHeaders = ['Situação cliente','Grupo empresarial','Razão Social','CNPJ/CPF','Nome Fantasia','Cidade','Vendedor Carteira','Débitos Originais (kg)','Obrigação de Sucata (kg)','Créditos (kg)','Saldo (kg)','Situação do Saldo','Início da Pendência','Dias em Atraso','Faixa de Atraso','Última Movimentação','Data do Último Débito','Peso do Último Débito (kg)','Data do Último Crédito','Peso do Último Crédito (kg)','Qtd. Lançamentos'] as const;
const uuid = z.uuid().transform((value) => value.toLowerCase());
const kg = z.string().regex(/^-?(?:0|[1-9]\d{0,11})\.\d{3}$/).refine((v) => v !== '-0.000');
const text = (max: number, required = false) => z.string().max(max).refine((v) => v === v.trim() && (!required || v.length > 0));
export const scrapLedgerEntrySchema = z.object({ sourceRow:z.number().int().min(2).max(maxScrapLedgerRows+1), sequence:text(80), operation:z.enum(['debit','credit']), clientExternalReference:z.string().regex(/^(?:\d{11}|\d{14})$/), clientName:text(200,true), city:text(120), seller:text(160), invoiceNumber:text(80), occurredOn:z.iso.date(), sourceWeightKg:kg, price:text(80), total:text(80), status:text(100), settlementMethod:text(120), duplicate:text(100), commitmentTerm:text(100), settlementTerm:text(100), notes:text(500), signedWeightKg:kg, portfolioSeller:text(160), tradeName:text(200), portfolioCity:text(120), groupName:text(200), clientStatus:text(100) }).strict();
export const scrapBalanceRowSchema = z.object({ sourceRow:z.number().int().min(5).max(10004), clientExternalReference:z.string().regex(/^(?:\d{11}|\d{14})$/), clientStatus:text(100), groupName:text(200), legalName:text(200,true), tradeName:text(200), city:text(120), portfolioSeller:text(160), originalDebitsKg:kg, obligationKg:kg, creditsKg:kg, balanceKg:kg, balanceStatus:text(120), pendingSince:z.iso.date().nullable(), overdueDays:z.number().int().min(0).max(100000).nullable(), overdueBand:text(100), lastMovementOn:z.iso.date().nullable(), lastDebitOn:z.iso.date().nullable(), lastDebitWeightKg:kg.nullable(), lastCreditOn:z.iso.date().nullable(), lastCreditWeightKg:kg.nullable(), entryCount:z.number().int().min(0).max(1_000_000) }).strict();
export type ScrapLedgerEntry = z.infer<typeof scrapLedgerEntrySchema>;
export type ScrapBalanceRow = z.infer<typeof scrapBalanceRowSchema>;
export const scrapLedgerHashSchema=z.string().regex(/^[a-f0-9]{64}$/);
export const scrapLedgerSyncRequestSchema=z.discriminatedUnion('trigger',[z.object({trigger:z.literal('manual'),idempotencyKey:uuid}).strict(),z.object({trigger:z.literal('scheduled')}).strict()]);
export const scrapLedgerBeginResultSchema=z.object({runId:uuid,leaseToken:uuid.nullable(),replayed:z.boolean()}).strict();
export const scrapLedgerStageRequestSchema=z.object({leaseToken:uuid,kind:z.enum(['entries','balances']),chunkIndex:z.number().int().nonnegative(),chunkHash:scrapLedgerHashSchema,rows:z.union([z.array(scrapLedgerEntrySchema).min(1).max(500),z.array(scrapBalanceRowSchema).min(1).max(500)])}).strict();
export const scrapLedgerStageResultSchema=z.object({stagedCount:z.number().int().nonnegative(),replayed:z.boolean()}).strict();
export const scrapLedgerPublishRequestSchema=z.object({leaseToken:uuid,entriesHash:scrapLedgerHashSchema,balancesHash:scrapLedgerHashSchema,expectedEntryCount:z.number().int().positive().max(maxScrapLedgerRows),expectedBalanceCount:z.number().int().positive().max(10000),parserVersion:z.literal(scrapLedgerParserVersion)}).strict();
export const scrapLedgerRunSchema=z.object({id:uuid,status:z.enum(['collecting','published','failed']),trigger:z.enum(['manual','scheduled']),startedAt:z.iso.datetime({offset:true}),completedAt:z.iso.datetime({offset:true}).nullable(),entryCount:z.number().int().nonnegative(),balanceCount:z.number().int().nonnegative(),errorCode:z.string().nullable()}).strict();
export const clientScrapSummarySchema = z.object({ generationId:uuid, publishedAt:z.iso.datetime({offset:true}), client:z.object({id:uuid,name:z.string().min(1).max(200)}), currentDebtKg:kg, balanceKg:kg, balanceStatus:z.string().max(120), lastCollectionOn:z.iso.date().nullable(), lastCollectionKg:kg.nullable(), averageMonthlyCredits12mKg:kg, averageMonthlyDebits12mKg:kg, trend:z.enum(['growing','falling','stable']), trendMethod:z.literal('recent_3m_vs_previous_3m_net_debt') }).strict();
export type ClientScrapSummary = z.infer<typeof clientScrapSummarySchema>;
export const scrapLedgerSyncStatusSchema = z.object({ configured:z.boolean(), reason:z.enum(['ready','disabled','missing_configuration','invalid_configuration']), scheduleEnabled:z.boolean(), timeZone:z.literal(scrapLedgerTimeZone), times:z.tuple([z.literal('08:00'),z.literal('18:00')]), latestRun:scrapLedgerRunSchema.nullable(), lastSuccessAt:z.iso.datetime({offset:true}).nullable() }).strict();
export type ScrapLedgerSyncStatus=z.infer<typeof scrapLedgerSyncStatusSchema>;

export function scrapLedgerScheduledSlot(now: Date): string | null {
  if (!Number.isFinite(now.getTime())) return null;
  const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:scrapLedgerTimeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now).map((x)=>[x.type,x.value]));
  const slot=p.hour==='08'?'08:00':p.hour==='18'?'18:00':null;
  return slot ? `${p.year}-${p.month}-${p.day}@${slot}` : null;
}
