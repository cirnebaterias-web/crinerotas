import type { MeResponse } from "@cirne/contracts";
import type { SupabaseClient } from "@supabase/supabase-js";
import { handleClientImportRequest } from "../client-imports/http";
import { RouteRequestError } from "../routes/http";

export const handleProductCatalogSyncRequest = handleClientImportRequest;

export async function readProductCatalogSyncJson(
  request: Request,
): Promise<unknown> {
  const limit = 1_024 * 1_024;
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
    "application/json"
  ) {
    throw new RouteRequestError(
      415,
      "VALIDATION_FAILED",
      "Use Content-Type application/json.",
      false,
    );
  }
  const advertised = request.headers.get("content-length");
  if (
    advertised !== null &&
    (!/^\d+$/.test(advertised) || !Number.isSafeInteger(Number(advertised)))
  ) {
    throw new RouteRequestError(
      400,
      "VALIDATION_FAILED",
      "Content-Length inválido.",
      false,
    );
  }
  if (advertised !== null && Number(advertised) > limit) {
    throw new RouteRequestError(
      413,
      "VALIDATION_FAILED",
      "Corpo excede 1 MiB.",
      false,
    );
  }
  if (!request.body)
    throw new RouteRequestError(
      400,
      "VALIDATION_FAILED",
      "Corpo JSON obrigatório.",
      false,
    );
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new RouteRequestError(
          413,
          "VALIDATION_FAILED",
          "Corpo excede 1 MiB.",
          false,
        );
      }
      chunks.push(value);
    }
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.concat(chunks, size),
        ),
      ) as unknown;
    } catch {
      throw new RouteRequestError(
        400,
        "VALIDATION_FAILED",
        "Corpo JSON inválido.",
        false,
      );
    }
  } finally {
    reader.releaseLock();
  }
}

export function requireProductCatalogSyncCapability(identity: MeResponse) {
  if (!identity.capabilities.includes("products.sync")) {
    throw new RouteRequestError(
      403,
      "FORBIDDEN",
      "Operação não autorizada.",
      false,
    );
  }
}

export async function productCatalogRpc(
  client: SupabaseClient,
  name: string,
  args: Record<string, unknown>,
) {
  const { data, error } = await client
    .schema("api")
    .rpc(name, args)
    .abortSignal(AbortSignal.timeout(30_000));
  if (!error) return data as unknown;
  if (error.code === "P0001" && error.message === "SALES_UNAVAILABLE") {
    throw new RouteRequestError(
      503,
      "DEPENDENCY_UNAVAILABLE",
      "Histórico ainda não disponibilizado.",
      false,
      { reason: "no_published_generation" },
    );
  }
  const known = {
    AUTH_REQUIRED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    VALIDATION_FAILED: 422,
    VERSION_CONFLICT: 409,
    IDEMPOTENCY_KEY_REUSED: 409,
    SYNC_BUSY: 409,
    SYNC_LEASE_EXPIRED: 409,
  } as const;
  if (error.code === "P0001" && error.message in known) {
    const name = error.message as keyof typeof known;
    const code =
      name === "SYNC_BUSY" || name === "SYNC_LEASE_EXPIRED"
        ? "VERSION_CONFLICT"
        : name;
    throw new RouteRequestError(
      known[name],
      code,
      code === "FORBIDDEN"
        ? "Operação não autorizada."
        : "Não foi possível concluir a operação do catálogo. Consulte o estado antes de repetir.",
      name === "SYNC_BUSY",
    );
  }
  throw new RouteRequestError(
    503,
    "DEPENDENCY_UNAVAILABLE",
    "Base de produtos temporariamente indisponível.",
    true,
  );
}
