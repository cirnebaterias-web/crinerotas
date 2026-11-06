import { describe, expect, it } from "vitest";
import {
  readProductCatalogServerConfig,
  readProductCatalogSheetConfig,
} from "./product-catalog-sync";

const base = {
  GOOGLE_PRODUCT_CATALOG_ENABLED: "true",
  GOOGLE_PRODUCT_CATALOG_SPREADSHEET_ID: "12345678901234567890",
  GOOGLE_PRODUCT_CATALOG_ACTOR_ID: "10000000-0000-4000-8000-000000000001",
};

describe("configuração privada do catálogo", () => {
  it("nasce desabilitada e não possui agenda automática", () => {
    expect(readProductCatalogServerConfig({})).toEqual({
      configured: false,
      reason: "disabled",
    });
  });

  it("separa configuração do servidor da credencial de aquisição", () => {
    expect(readProductCatalogServerConfig(base)).toMatchObject({
      configured: true,
      config: { spreadsheetId: base.GOOGLE_PRODUCT_CATALOG_SPREADSHEET_ID },
    });
    expect(readProductCatalogSheetConfig(base)).toEqual({
      configured: false,
      reason: "missing_configuration",
    });
  });
});
