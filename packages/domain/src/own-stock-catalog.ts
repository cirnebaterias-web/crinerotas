import {
  generatedOwnProductItems,
  GENERATED_STOCK_CATALOG_PROVENANCE,
  GENERATED_STOCK_CATALOG_VALID_FROM,
  GENERATED_STOCK_CATALOG_VERSION,
} from './own-product-catalog.generated';

// This entry preserves v2 identity and metadata. Future publications must add a
// separate versioned artifact/entry instead of replacing historical metadata.
export const supportedStockInsightsCatalogs = {
  publishedCatalogVersion: GENERATED_STOCK_CATALOG_VERSION,
  catalogs: [{
    version: GENERATED_STOCK_CATALOG_VERSION,
    validFrom: GENERATED_STOCK_CATALOG_VALID_FROM,
    provenance: GENERATED_STOCK_CATALOG_PROVENANCE,
    products: generatedOwnProductItems.map((item) => ({ ...item, code: item.factoryCode })),
  }],
};

export {
  generatedOwnProductItems,
  GENERATED_STOCK_CATALOG_PROVENANCE,
  GENERATED_STOCK_CATALOG_VALID_FROM,
  GENERATED_STOCK_CATALOG_VERSION,
};
