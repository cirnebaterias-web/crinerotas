import { createPrivateKey, sign } from "node:crypto";
import { z } from "zod";
import type { ProductCatalogSheetConfig } from "@cirne/config/product-catalog-sync";
import {
  maxProductCatalogRows,
  productCatalogHeaders,
  productCatalogRange,
} from "@cirne/contracts";
import type { ProductCatalogProjectedRow } from "@cirne/domain";

const tokenUrl = "https://oauth2.googleapis.com/token";
const scope = "https://www.googleapis.com/auth/spreadsheets.readonly";
const cellSchema = z.union([z.string(), z.number().finite(), z.boolean()]);
const responseSchema = z
  .object({
    range: z.string(),
    majorDimension: z.literal("ROWS"),
    values: z.array(z.array(cellSchema)).max(maxProductCatalogRows + 1),
  })
  .strict();

export class ProductCatalogAcquisitionError extends Error {
  constructor(
    public readonly code:
      | "SOURCE_UNAVAILABLE"
      | "SOURCE_INVALID"
      | "SOURCE_CHANGED"
      | "SOURCE_TOO_LARGE",
  ) {
    super(
      "Não foi possível validar a captura da base de produtos. Consulte o estado e a configuração privada.",
    );
  }
}
const unavailable = () =>
  new ProductCatalogAcquisitionError("SOURCE_UNAVAILABLE");

async function boundedJson(
  response: Response,
  limit: number,
): Promise<unknown> {
  if (!response.ok || !response.body) throw unavailable();
  const reader = response.body.getReader();
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new ProductCatalogAcquisitionError("SOURCE_TOO_LARGE");
      }
      chunks.push(value);
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks, length),
      ),
    ) as unknown;
  } finally {
    reader.releaseLock();
  }
}

type GoogleOptions = {
  transport?: typeof fetch;
  clock?: () => Date;
  sleep?: (ms: number) => Promise<void>;
};
async function readWithRetry(
  url: string,
  init: RequestInit,
  options: GoogleOptions,
) {
  const transport = options.transport ?? fetch;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < 3; attempt++) {
    let response: Response;
    try {
      response = await transport(url, {
        ...init,
        signal: AbortSignal.timeout(30_000),
        redirect: "error",
        cache: "no-store",
      });
    } catch {
      if (attempt === 2) throw unavailable();
      await sleep(1_000 * 2 ** attempt);
      continue;
    }
    if (
      ![408, 429, 500, 502, 503, 504].includes(response.status) ||
      attempt === 2
    )
      return response;
    const raw = response.headers.get("retry-after");
    const retryMs =
      raw && /^\d+$/.test(raw)
        ? Number(raw) * 1_000
        : raw
          ? Date.parse(raw) - (options.clock ?? (() => new Date()))().getTime()
          : 0;
    await response.body?.cancel();
    if (retryMs > 10_000) throw unavailable();
    await sleep(
      Math.max(1_000 * 2 ** attempt, Number.isFinite(retryMs) ? retryMs : 0),
    );
  }
  throw unavailable();
}

export function projectProductCatalogGoogleResponse(
  body: unknown,
): ProductCatalogProjectedRow[] {
  try {
    const parsed = responseSchema.parse(body);
    if (!/^(?:'Base produtos'|Base produtos)!A1:R\d+$/.test(parsed.range)) {
      throw new ProductCatalogAcquisitionError("SOURCE_INVALID");
    }
    const [header, ...data] = parsed.values;
    if (
      !header ||
      header.length !== productCatalogHeaders.length ||
      header.some((value, index) => value !== productCatalogHeaders[index])
    ) {
      throw new ProductCatalogAcquisitionError("SOURCE_INVALID");
    }
    const rows: ProductCatalogProjectedRow[] = [];
    for (let index = 0; index < data.length; index++) {
      const cells = data[index]!;
      if (cells.length > productCatalogHeaders.length)
        throw new ProductCatalogAcquisitionError("SOURCE_INVALID");
      if (cells.every((cell) => String(cell).trim() === "")) continue;
      rows.push({ sourceRow: index + 2, cells });
    }
    if (!rows.length)
      throw new ProductCatalogAcquisitionError("SOURCE_INVALID");
    return rows;
  } catch (error) {
    if (error instanceof ProductCatalogAcquisitionError) throw error;
    throw new ProductCatalogAcquisitionError("SOURCE_INVALID");
  }
}

/** Node-only acquisition. The Google credential and spreadsheet id never cross the BFF or browser. */
export async function createGoogleProductCatalogReader(
  config: ProductCatalogSheetConfig,
  options: GoogleOptions = {},
) {
  try {
    const key = createPrivateKey(config.privateKey);
    if (
      key.asymmetricKeyType !== "rsa" ||
      (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2_048
    )
      throw unavailable();
    const issued = Math.floor(
      (options.clock ?? (() => new Date()))().getTime() / 1_000,
    );
    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
      iss: config.email,
      scope,
      aud: tokenUrl,
      iat: issued,
      exp: issued + 300,
    })}`;
    const assertion = `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), key).toString("base64url")}`;
    const tokenResponse = await readWithRetry(
      tokenUrl,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion,
        }),
      },
      options,
    );
    const token = z
      .object({
        access_token: z.string().min(1).max(8_192),
        token_type: z.literal("Bearer"),
      })
      .parse(await boundedJson(tokenResponse, 32 * 1_024));
    const url = new URL(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(config.spreadsheetId)}/values/${encodeURIComponent(productCatalogRange)}`,
    );
    url.searchParams.set("majorDimension", "ROWS");
    url.searchParams.set("valueRenderOption", "FORMATTED_VALUE");
    return async (): Promise<ProductCatalogProjectedRow[]> => {
      try {
        const response = await readWithRetry(
          url.href,
          { headers: { authorization: `Bearer ${token.access_token}` } },
          options,
        );
        return projectProductCatalogGoogleResponse(
          await boundedJson(response, 8 * 1_024 * 1_024),
        );
      } catch (error) {
        if (error instanceof ProductCatalogAcquisitionError) throw error;
        throw unavailable();
      }
    };
  } catch (error) {
    if (error instanceof ProductCatalogAcquisitionError) throw error;
    throw unavailable();
  }
}
