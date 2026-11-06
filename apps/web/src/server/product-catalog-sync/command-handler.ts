import { z } from "zod";
import {
  productCatalogSyncFailRequestSchema,
  productCatalogSyncPublishRequestSchema,
  productCatalogSyncStageRequestSchema,
} from "@cirne/contracts";
import { parseBearer } from "../identity";
import { RouteRequestError } from "../routes/http";
import {
  handleProductCatalogSyncRequest,
  readProductCatalogSyncJson,
  requireProductCatalogSyncCapability,
} from "./http";
import {
  failProductCatalogSync,
  publishProductCatalogSync,
  stageProductCatalogSync,
} from "./service";

export function productCatalogRunCommand(
  action: "stage" | "publish" | "fail",
  request: Request,
  params: Promise<{ runId: string }>,
) {
  return handleProductCatalogSyncRequest(
    request,
    `/api/v1/product-catalog-sync/runs/[runId]/${action}`,
    async ({ identity, client }, headers) => {
      requireProductCatalogSyncCapability(identity);
      if (!parseBearer(request.headers.get("authorization"))) {
        throw new RouteRequestError(
          403,
          "FORBIDDEN",
          "Use a identidade da CLI.",
          false,
        );
      }
      const id = z.uuid().safeParse((await params).runId);
      if (!id.success)
        throw new RouteRequestError(
          422,
          "VALIDATION_FAILED",
          "Identificador inválido.",
          false,
        );
      const body = await readProductCatalogSyncJson(request);
      if (action === "stage") {
        const command = productCatalogSyncStageRequestSchema.safeParse(body);
        if (!command.success)
          throw new RouteRequestError(
            422,
            "VALIDATION_FAILED",
            "Lote de produtos inválido.",
            false,
          );
        return Response.json(
          await stageProductCatalogSync(client, id.data, command.data),
          { headers },
        );
      }
      if (action === "publish") {
        const command = productCatalogSyncPublishRequestSchema.safeParse(body);
        if (!command.success)
          throw new RouteRequestError(
            422,
            "VALIDATION_FAILED",
            "Publicação inválida.",
            false,
          );
        return Response.json(
          await publishProductCatalogSync(client, id.data, command.data),
          { headers },
        );
      }
      const command = productCatalogSyncFailRequestSchema.safeParse(body);
      if (!command.success)
        throw new RouteRequestError(
          422,
          "VALIDATION_FAILED",
          "Falha inválida.",
          false,
        );
      return Response.json(
        await failProductCatalogSync(client, id.data, command.data),
        { headers },
      );
    },
  );
}
