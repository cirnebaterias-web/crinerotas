import { productCatalogRunCommand } from "@/server/product-catalog-sync/command-handler";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function POST(
  request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  return productCatalogRunCommand("stage", request, context.params);
}
