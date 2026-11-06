import { createPrivateKey, sign } from 'node:crypto';
import { z } from 'zod';
import type { SalesSheetConfig } from '@cirne/config/sales-sync';
import { salesSheetHeaders } from '@cirne/contracts';
import type { SalesProjectedRow } from '@cirne/domain';

const tokenUrl = 'https://oauth2.googleapis.com/token';
const scope = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const ranges = ['A1:AL1', 'B2:B', 'I2:M', 'R2:T', 'AB2:AD', 'AH2:AH', 'AL2:AL'] as const;
const widths = [38, 1, 5, 3, 3, 1, 1];
const cellSchema = z.union([z.string(), z.number().finite(), z.boolean()]);
const responseSchema = z.object({ valueRanges: z.array(z.object({
  range: z.string(), majorDimension: z.literal('ROWS'), values: z.array(z.array(cellSchema)).optional(),
})).length(7) });
export class SalesAcquisitionError extends Error {
  constructor(public readonly code: 'SOURCE_UNAVAILABLE' | 'SOURCE_INVALID' | 'SOURCE_CHANGED' | 'SOURCE_TOO_LARGE') {
    super('Não foi possível validar a captura de Vendas. Consulte o estado e a configuração privada.');
  }
}
const unavailable = () => new SalesAcquisitionError('SOURCE_UNAVAILABLE');

async function boundedJson(response: Response, limit: number): Promise<unknown> {
  if (!response.ok || !response.body) throw unavailable();
  const reader = response.body.getReader();
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) { await reader.cancel(); throw new SalesAcquisitionError('SOURCE_TOO_LARGE'); }
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length))) as unknown;
  } finally { reader.releaseLock(); }
}

type GoogleOptions = { transport?: typeof fetch; clock?: () => Date; sleep?: (ms: number) => Promise<void> };
async function readWithRetry(url: string, init: RequestInit, options: GoogleOptions) {
  const transport = options.transport ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < 3; attempt++) {
    let response: Response;
    try { response = await transport(url, { ...init, signal: AbortSignal.timeout(30_000), redirect: 'error', cache: 'no-store' }); }
    catch { if (attempt === 2) throw unavailable(); await sleep(1000 * 2 ** attempt); continue; }
    if (![408, 429, 500, 502, 503, 504].includes(response.status) || attempt === 2) return response;
    const raw = response.headers.get('retry-after');
    const retryMs = raw && /^\d+$/.test(raw) ? Number(raw) * 1000
      : raw ? Date.parse(raw) - (options.clock ?? (() => new Date()))().getTime() : 0;
    await response.body?.cancel();
    // Do not exceed the run lease or disregard a provider's longer cooldown.
    if (retryMs > 10_000) throw unavailable();
    await sleep(Math.max(1000 * 2 ** attempt, Number.isFinite(retryMs) ? retryMs : 0));
  }
  throw unavailable();
}

export function projectSalesGoogleResponse(body: unknown): SalesProjectedRow[] {
  try {
    const parsed = responseSchema.parse(body);
    for (let index = 0; index < ranges.length; index++) {
      const entry = parsed.valueRanges[index]!;
      const expected = ranges[index]!;
      // Google expands open ranges to the sheet's grid end; ensure start/columns are exact.
      const [start, end] = expected.split(':');
      const endColumn = end!.replace(/\d/g, '');
      const pattern = new RegExp(`^(?:'Vendas'|Vendas)!${start}:${endColumn}\\d+$`);
      if ((entry.values?.length ?? 0) > (index === 0 ? 1 : 100_000)) throw new SalesAcquisitionError('SOURCE_TOO_LARGE');
      if (!pattern.test(entry.range) || (index === 0 && !entry.range.endsWith(':AL1')) ||
        entry.values?.some((row) => row.length > widths[index]!)) throw new SalesAcquisitionError('SOURCE_INVALID');
    }
    const header = parsed.valueRanges[0]!.values?.[0];
    if (!header || header.length !== salesSheetHeaders.length || header.some((value, index) =>
      typeof value !== 'string' || value.trim() !== salesSheetHeaders[index]!.trim())) throw new SalesAcquisitionError('SOURCE_INVALID');
    const data = parsed.valueRanges.slice(1).map((range) => range.values ?? []);
    const length = Math.max(...data.map((rows) => rows.length));
    const rows: SalesProjectedRow[] = [];
    for (let index = 0; index < length; index++) {
      const document = data[0]![index] ?? [];
      const sale = data[1]![index] ?? [];
      const product = data[2]![index] ?? [];
      const classification = data[3]![index] ?? [];
      const kind = data[4]![index] ?? [];
      const key = data[5]![index] ?? [];
      if ([...document, ...sale, ...product, ...classification, ...kind, ...key].every((cell) => cell === '')) continue;
      rows.push({ sourceRow: index + 2, cells: {
        clientExternalReference: document[0], invoiceNumber: sale[0], saleDate: sale[1], sku: sale[2],
        volume: sale[3], totalAmount: sale[4], productDescription: product[0], itemGroup: product[1],
        itemSubgroup: product[2], category: classification[0], brand: classification[1], line: classification[2],
        kind: kind[0], externalKey: key[0],
      } });
    }
    if (!rows.length) throw new SalesAcquisitionError('SOURCE_INVALID');
    return rows;
  } catch (error) { if (error instanceof SalesAcquisitionError) throw error; throw new SalesAcquisitionError('SOURCE_INVALID'); }
}

/** Node-only acquisition. The Google credential never crosses the BFF or a browser. */
export async function createGoogleSalesReader(config: SalesSheetConfig, options: GoogleOptions = {}) {
  try {
    const key = createPrivateKey(config.privateKey);
    if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw unavailable();
    const issued = Math.floor((options.clock ?? (() => new Date()))().getTime() / 1000);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iss: config.email, scope,
      aud: tokenUrl, iat: issued, exp: issued + 300 })}`;
    const assertion = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), key).toString('base64url')}`;
    const tokenResponse = await readWithRetry(tokenUrl, { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    }, options);
    const token = z.object({ access_token: z.string().min(1).max(8192), token_type: z.literal('Bearer') })
      .parse(await boundedJson(tokenResponse, 32 * 1024));
    const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(config.spreadsheetId)}/values:batchGet`);
    ranges.forEach((range) => url.searchParams.append('ranges', `'Vendas'!${range}`));
    url.searchParams.set('majorDimension', 'ROWS');
    url.searchParams.set('valueRenderOption', 'FORMATTED_VALUE');
    return async (): Promise<SalesProjectedRow[]> => {
      try {
        const response = await readWithRetry(url.href, { headers: { authorization: `Bearer ${token.access_token}` } }, options);
        return projectSalesGoogleResponse(await boundedJson(response, 32 * 1024 * 1024));
      } catch (error) { if (error instanceof SalesAcquisitionError) throw error; throw unavailable(); }
    };
  } catch (error) { if (error instanceof SalesAcquisitionError) throw error; throw unavailable(); }
}
