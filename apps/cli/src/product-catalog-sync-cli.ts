import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { productCatalogSyncRequestSchema } from "@cirne/contracts";
import {
  loginProductCatalogOperator,
  productCatalogSyncCommand,
} from "./product-catalog-sync";

try {
  const { values } = parseArgs({
    options: {
      url: {
        type: "string",
        default: process.env.APP_BASE_URL ?? "http://127.0.0.1:3000",
      },
      status: { type: "boolean" },
      key: { type: "string" },
      json: { type: "boolean" },
    },
    strict: true,
  });
  if (values.key && values.status) throw new Error();
  const token = await loginProductCatalogOperator(process.env);
  const command = values.status
    ? null
    : productCatalogSyncRequestSchema.parse({
        trigger: "manual",
        idempotencyKey: values.key ?? randomUUID(),
      });
  if (command)
    console.error(
      JSON.stringify({
        status: "starting",
        idempotencyKey: command.idempotencyKey,
      }),
    );
  const result = await productCatalogSyncCommand(values.url, token, command);
  console.log(JSON.stringify(result));
  if ("status" in result && result.status !== "published")
    process.exitCode = result.status === "collecting" ? 2 : 1;
} catch {
  console.error(
    JSON.stringify({
      status: "error",
      message:
        "Base de produtos não atualizada. Confira configuração, argumentos e estado; preserve a chave da intenção.",
    }),
  );
  process.exitCode = 1;
}
