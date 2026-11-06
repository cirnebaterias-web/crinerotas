import {
  handleProductCatalogSyncRequest,
  requireProductCatalogSyncCapability,
} from "@/server/product-catalog-sync/http";
import { getProductCatalogSyncStatus } from "@/server/product-catalog-sync/service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request) {
  return handleProductCatalogSyncRequest(
    request,
    "/api/v1/product-catalog-sync",
    async ({ identity, client }, headers) => {
      requireProductCatalogSyncCapability(identity);
      return Response.json(await getProductCatalogSyncStatus(client), {
        headers,
      });
    },
  );
}
