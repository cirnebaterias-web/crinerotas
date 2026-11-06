import { createHash } from 'node:crypto';
import { z } from 'zod';
import { readSalesSheetSyncConfig } from '@cirne/config/sales-sync';
import { salesSyncPath, salesSyncRunsPath, salesRunPath, salesSyncStatusSchema, salesSyncResultSchema,
  salesSyncBeginResultSchema, salesSyncStageResultSchema, salesSyncStageRequestSchema, salesParserVersion,
  type SalesSyncRequest, type SalesImportRow } from '@cirne/contracts';
import { normalizeSalesRows, salesRowTuple, SalesSourceValidationError, type SalesProjectedRow } from '@cirne/domain';
import { safeSyncOrigin, loginSheetSyncOperator } from './client-sheet-sync';
import { createGoogleSalesReader, SalesAcquisitionError } from './sales-google';

export class SalesSyncCommandError extends Error {
  constructor(public readonly code: 'PERSISTENCE_FAILED' | 'VALIDATION_FAILED' = 'PERSISTENCE_FAILED') {
    super('Não foi possível concluir a importação de vendas. Consulte o estado; repita a mesma intenção antes de iniciar outra.');
  }
}
type Options = { transport?: typeof fetch; sleep?: (ms: number) => Promise<void>;
  clock?: () => Date; env?: Record<string, string | undefined>; readSheet?: () => Promise<SalesProjectedRow[]> };

async function commandRequest<T>(baseUrl: string, token: string, path: string, body: unknown,
  schema: z.ZodType<T>, options: Options): Promise<T> {
  const payload = body === null ? undefined : JSON.stringify(body);
  if (payload && Buffer.byteLength(payload, 'utf8') > 1024 * 1024) throw new SalesSyncCommandError('VALIDATION_FAILED');
  for (let attempt = 0; attempt < 3; attempt++) {
    let retryDelay = 1000 * 2 ** attempt;
    try {
      const response = await (options.transport ?? fetch)(new URL(path, safeSyncOrigin(baseUrl)), {
        method: payload ? 'POST' : 'GET', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(40_000),
        headers: { authorization: `Bearer ${token}`, ...(payload ? { 'content-type': 'application/json' } : {}) }, body: payload,
      });
      if (!response.ok) {
        const retryAfter = response.headers.get('retry-after');
        if (retryAfter) {
          const delay = /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000
            : Date.parse(retryAfter) - (options.clock ?? (() => new Date()))().getTime();
          if (delay > 10_000) { await response.body?.cancel(); throw new SalesSyncCommandError(); }
          if (Number.isFinite(delay)) retryDelay = Math.max(retryDelay, delay);
        }
        await response.body?.cancel();
        if (![408, 429, 502, 503, 504].includes(response.status)) throw new SalesSyncCommandError();
        if (attempt === 2) throw new SalesSyncCommandError();
      } else {
        if (!response.body) throw new SalesSyncCommandError();
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = []; let size = 0;
        try {
          while (true) {
            const { value, done } = await reader.read(); if (done) break;
            size += value.byteLength;
            if (size > 64 * 1024) { await reader.cancel(); throw new SalesSyncCommandError(); }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
        return schema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))) as unknown);
      }
    } catch (error) {
      if (error instanceof SalesSyncCommandError || error instanceof z.ZodError || attempt === 2) throw new SalesSyncCommandError();
    }
    await (options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(retryDelay);
  }
  throw new SalesSyncCommandError();
}
export function salesContentHash(rows: readonly SalesImportRow[]) {
  const hash = createHash('sha256');
  for (const row of rows) hash.update(createHash('sha256').update(JSON.stringify(salesRowTuple(row)), 'utf8').digest('hex'));
  return hash.digest('hex');
}
export function salesStageChunks(rows: readonly SalesImportRow[], leaseToken: string) {
  const chunks: z.infer<typeof salesSyncStageRequestSchema>[] = [];
  let index = 0;
  while (index < rows.length) {
    let count = Math.min(500, rows.length - index);
    while (count > 0) {
      const chunk = rows.slice(index, index + count);
      const command = { leaseToken, chunkIndex: chunks.length, chunkHash: salesContentHash(chunk), rows: chunk };
      if (Buffer.byteLength(JSON.stringify(command), 'utf8') <= 1024 * 1024) {
        chunks.push(salesSyncStageRequestSchema.parse(command)); index += count; break;
      }
      count = Math.floor(count / 2);
    }
    if (count === 0) throw new SalesSyncCommandError('VALIDATION_FAILED');
  }
  return chunks;
}
export async function salesSyncCommand(baseUrl: string, token: string, command: SalesSyncRequest | null, options: Options = {}) {
  if (!command) return commandRequest(baseUrl, token, salesSyncPath, null, salesSyncStatusSchema, options);
  const state = readSalesSheetSyncConfig(options.env ?? process.env);
  if (!state.configured) throw new SalesSyncCommandError('VALIDATION_FAILED');
  const begin = await commandRequest(baseUrl, token, salesSyncRunsPath, command, salesSyncBeginResultSchema, options);
  if (!begin.leaseToken) return begin.result;
  let publishing = false;
  try {
    const read = options.readSheet ?? await createGoogleSalesReader(state.config,
      { transport: options.transport, sleep: options.sleep, clock: options.clock });
    const first = normalizeSalesRows(await read());
    const contentHash = salesContentHash(first);
    const second = normalizeSalesRows(await read());
    if (contentHash !== salesContentHash(second)) throw new SalesAcquisitionError('SOURCE_CHANGED');
    for (const chunk of salesStageChunks(second, begin.leaseToken)) {
      await commandRequest(baseUrl, token, `${salesRunPath(begin.runId)}/stage`, chunk, salesSyncStageResultSchema, options);
    }
    publishing = true;
    return await commandRequest(baseUrl, token, `${salesRunPath(begin.runId)}/publish`, {
      leaseToken: begin.leaseToken, contentHash, expectedRowCount: second.length, parserVersion: salesParserVersion,
    }, salesSyncResultSchema, options);
  } catch (error) {
    // A lost publish response is ambiguous: preserve the run and recover via the SAME begin key.
    if (!publishing) {
      const errorCode = error instanceof SalesAcquisitionError || error instanceof SalesSourceValidationError || error instanceof SalesSyncCommandError
        ? error.code : 'PERSISTENCE_FAILED';
      await commandRequest(baseUrl, token, `${salesRunPath(begin.runId)}/fail`, { leaseToken: begin.leaseToken, errorCode },
        salesSyncResultSchema, options).catch(() => undefined);
    }
    if (error instanceof SalesAcquisitionError || error instanceof SalesSourceValidationError || error instanceof SalesSyncCommandError) throw error;
    throw new SalesSyncCommandError();
  }
}
export function loginSalesSyncOperator(env: Record<string, string | undefined>, transport: typeof fetch = fetch) {
  return loginSheetSyncOperator({ ...env, CIRNE_SHEET_SYNC_EMAIL: env.CIRNE_SALES_SYNC_EMAIL,
    CIRNE_SHEET_SYNC_PASSWORD: env.CIRNE_SALES_SYNC_PASSWORD }, transport);
}
