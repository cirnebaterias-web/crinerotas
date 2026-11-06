import { createPrivateKey, sign } from 'node:crypto';
import { z } from 'zod';
import type { ClientSheetConfig } from '@cirne/config/client-sheet-sync';
import { RouteRequestError } from '../routes/http';

const tokenUrl = 'https://oauth2.googleapis.com/token';
const scope = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const valuesSchema = z.object({ values: z.array(z.array(z.union([z.string(), z.number(), z.boolean()])).max(21)).max(5001) });
const failure = () => new RouteRequestError(503, 'DEPENDENCY_UNAVAILABLE',
  'Não foi possível ler o Google Sheets. Confira a credencial, a permissão de leitura e o limite da base.', true);

async function boundedJson(response: Response, limit: number): Promise<unknown> {
  if (!response.ok || !response.body) throw failure();
  const reader = response.body.getReader();
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) { await reader.cancel(); throw failure(); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks, length).toString('utf8')) as unknown;
  } finally { reader.releaseLock(); }
}

export async function readGoogleClientSheet(config: ClientSheetConfig,
  transport: typeof fetch = fetch, clock: () => Date = () => new Date()) {
  try {
    const key = createPrivateKey(config.privateKey);
    if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw failure();
    const issued = Math.floor(clock().getTime() / 1000);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
      iss: config.email, scope, aud: tokenUrl, iat: issued, exp: issued + 300,
    })}`;
    const assertion = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), key).toString('base64url')}`;
    // Endpoints are constants; no cell, browser input or token response supplies a URL.
    const tokenResponse = await transport(tokenUrl, {
      method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    });
    const token = z.object({ access_token: z.string().min(1).max(8192), token_type: z.literal('Bearer') })
      .parse(await boundedJson(tokenResponse, 32 * 1024));
    // Reading the full column range under a byte/row cap also detects data after blank gaps.
    const range = encodeURIComponent("'Base clientes'!A:U");
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(config.spreadsheetId)}/values/${range}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`;
    const response = await transport(url, {
      redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${token.access_token}` },
    });
    return valuesSchema.parse(await boundedJson(response, 5 * 1024 * 1024)).values;
  } catch {
    // Never propagate provider messages, JWTs, key material or cell content into logs/HTTP.
    throw failure();
  }
}
