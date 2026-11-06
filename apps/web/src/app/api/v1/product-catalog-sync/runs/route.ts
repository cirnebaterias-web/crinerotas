import { productCatalogSyncRequestSchema } from "@cirne/contracts";
import { parseBearer } from "@/server/identity";
import {
  handleProductCatalogSyncRequest,
  requireProductCatalogSyncCapability,
} from "@/server/product-catalog-sync/http";
import { beginProductCatalogSync } from "@/server/product-catalog-sync/service";
import { readRouteJson, RouteRequestError } from "@/server/routes/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function POST(request: Request) {
  return handleProductCatalogSyncRequest(
    request,
    "/api/v1/product-catalog-sync/runs",
    async ({ identity, client }, headers) => {
      requireProductCatalogSyncCapability(identity);
      const command = productCatalogSyncRequestSchema.safeParse(
        await readRouteJson(request),
      );
      if (!command.success)
        throw new RouteRequestError(
          422,
          "VALIDATION_FAILED",
          "Comando do catálogo inválido.",
          false,
        );
      return Response.json(
        await beginProductCatalogSync(
          client,
          identity,
          command.data,
          parseBearer(request.headers.get("authorization")) ? "cli" : "web",
        ),
        { headers },
      );
    },
  );
}
