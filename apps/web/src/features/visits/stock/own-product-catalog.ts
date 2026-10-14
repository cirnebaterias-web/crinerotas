import type { OwnStockLine } from '@cirne/contracts';
import {
  generatedOwnProductItems,
  GENERATED_STOCK_CATALOG_VALID_FROM,
  GENERATED_STOCK_CATALOG_VERSION,
} from './own-product-catalog.generated';

export const OWN_STOCK_BRANDS = ['Heliar', 'América', 'Durex', 'ACDelco'] as const;
export type OwnStockBrand = typeof OWN_STOCK_BRANDS[number];

export const COMPETITOR_STOCK_BRANDS = ['Moura', 'Zetta', 'Bosh', 'Tudor', 'Pioneiro'] as const;
export const COMPETITOR_STOCK_TECHNOLOGIES = ['SLI', 'EFB', 'AGM'] as const;
export const STOCK_CATALOG_VERSION = GENERATED_STOCK_CATALOG_VERSION;
export const STOCK_CATALOG_VALID_FROM = GENERATED_STOCK_CATALOG_VALID_FROM;

export type OwnProductItem = (typeof generatedOwnProductItems)[number];
export const ownProductItems = generatedOwnProductItems;
export const ownProductItemsByBrand: Record<OwnStockBrand, OwnProductItem[]> = Object.fromEntries(
  OWN_STOCK_BRANDS.map((brand) => [brand, ownProductItems.filter((item) => item.brand === brand)]),
) as Record<OwnStockBrand, OwnProductItem[]>;
export const ownProductByFactoryCode = new Map<string, OwnProductItem>(
  ownProductItems.map((item) => [item.factoryCode, item]),
);

export const ownProductCatalog: Record<OwnStockBrand, string[]> = {
  Heliar: [
    'AG105SD 24-950', 'AG60HD 24-600', 'AG70PD 24-760', 'AG80KD H 24M', 'AG95MD H 24M',
    'H100LE 15-750', 'H100LE H 15M', 'H150TD 15-900', 'H38JD 24-320', 'H40JD 24-320',
    'H40JD JIS 24-300', 'H45JE 24-340', 'H48BD 24-375', 'H50JD 24-405', 'H52GD 24-450',
    'H60DD 24-480', 'H60HD 24-480', 'H65HD 24-550', 'H70ND 24-600', 'H70ND 24-660',
    'H70NE 24-610', 'H75LD 18-530', 'H75LE 18-530', 'H75PD 24-620', 'H90LD 18-710',
    'H90LE 18-710', 'H95MD 18-800', 'H95MD H 18M', 'HAGM105SD 24-950', 'HAGM60HD 24-600',
    'HAGM70PD 24-760', 'HAGM80KD 24-800', 'HAGM80KD H 24M', 'HAGM95MD 24-850', 'HC100LE 15-950',
    'HE45BE 24-330', 'HE48BD 24-375', 'HE50GD 24-420', 'HE5D ECO', 'HE60DD 24-480',
    'HE60DE 24-440', 'HE60HD 24-480', 'HE65HD 24-550', 'HEFB225TD 24-1050',
    'HEFB225TD H 24M', 'HEFB225TE 24-1050', 'HEFB225TE H 24M', 'HEFB230TE 24-1050',
    'HEFB50GD 24-540', 'HEFB50GD H 24M', 'HEFB60HD 24-560', 'HEFB60HD H 24M',
    'HEFB68HD H 24M', 'HEFB72PD 24-700', 'HF52GD 24-450', 'HF60DD H 24M', 'HF60HD H 24M',
    'HF65HD 24-550', 'HF75PD H 24M', 'HFB60HD H 24M', 'HFS150TD 15-850', 'HFT150TD H 15M',
    'HG38JD 24-320', 'HG45BD H 24M', 'HG45BE 24-330', 'HG45JE 24-340', 'HG70ND 24-500',
    'HG75LD 18-530', 'HG75LE 18-530', 'HG90LD H 18M', 'HG95MD 18-800', 'HGD75LD 18-630',
    'HGR60DD 24-440', 'HGR60DE 24-440', 'HGR60HD 24-440', 'HNP45BD 24-330',
    'HNP60DD 24-440', 'HNP60HD 24-440', 'HS100LE 15-750', 'HS150TD 15-900',
    'HS180TD 15-950', 'HS180TE 15-950', 'HS200TD 15-1100', 'HT180TD H 15M',
    'HT180TE 15-1050', 'HT180TE H 15M', 'HTZ12S-BS', 'HTZ6L POWERSPORTS',
    'HTZ7L POWERSPORTS', 'HV48BD H 30M', 'HV52GD H 30M', 'HV60DD H 30M', 'HV60HD H 30M',
    'RT100LE 15-750', 'RT225TD 15-1050', 'RT225TE 15-1050', 'SAR180TE 15-1050',
    'SRT180TD 15-1050', 'SRT180TE 15-1050',
  ],
  América: [
    'AM100LE A 15M', 'AM170TD A 15M', 'AM38JD 18-300', 'AM45JD 18-340', 'AM75LD 18-500',
    'AM90LD 18-690', 'AMEFB50GD 18-540', 'AMEFB60HD 18-560', 'AMEFB70PD 18-700',
    'AMF150TD 15-800', 'AMR45BD 18-310', 'AMR45BE A 18M', 'AMR50GD 18-370',
    'AMR60DD 18-375', 'AMR60DE A 18M', 'AMR60HD 18-375', 'AMR70ND 18-450',
    'AMR70NE A 18M', 'AMS180TE A 15M',
  ],
  Durex: ['ST50GD 12-370', 'ST60DD 12-375', 'ST70ND 12-450', 'ST100LE 12-640', 'ST50DD 12-375', 'D60DD 12-400'],
  ACDelco: [
    'ADF72PD 24-700', 'ADG60HD A 24M', 'ADR100LE 15-750', 'ADR150TD A 15 M',
    'ADR50GD 18-410', 'ADR50JD A 18 M', 'ADR60DD 18-425', 'ADR60HD 18-425',
    'ADR70ND 18-500', 'ADR75LD A 18 M', 'ADR90LD 18-710', 'ADR90LE 18-710',
    'ADR95MD 18-800', 'ADRD75LD 18-630', 'ADRD90LD A 18 M', 'ADS48BD 24-375',
    'ADS52GD 24-450', 'ADS60DD 24-480', 'ADS60HD 24-480', 'ADS65HD 24-550',
    'ADS70ND 24-660', 'ADS75PD 24-620',
  ],
};

export const stockCatalog = {
  schemaVersion: 1,
  version: STOCK_CATALOG_VERSION,
  validFrom: STOCK_CATALOG_VALID_FROM,
  status: 'published',
  ownBrands: OWN_STOCK_BRANDS,
  ownModels: ownProductCatalog,
  ownProducts: ownProductItems,
  competitorBrands: COMPETITOR_STOCK_BRANDS,
  competitorTechnologies: COMPETITOR_STOCK_TECHNOLOGIES,
} as const;

export function ownLinesForBrand(lines: OwnStockLine[] | undefined, brand: OwnStockBrand) {
  return (lines ?? []).filter((line) => line.brand === brand);
}

export const FALLBACK_UNIT_WEIGHT_KG = '15';

export function productForLine(line: OwnStockLine) {
  return line.productCode ? ownProductByFactoryCode.get(line.productCode) : undefined;
}

export function unitWeightForLine(line: OwnStockLine) {
  return Number(line.unitWeightKg ?? productForLine(line)?.unitWeightKg ?? FALLBACK_UNIT_WEIGHT_KG);
}

export function lineWeightKg(line: OwnStockLine) {
  return line.quantity * unitWeightForLine(line);
}

export function stockWeightKg(lines: OwnStockLine[] | undefined, brand?: OwnStockBrand) {
  return (lines ?? []).filter((line) => !brand || line.brand === brand)
    .reduce((total, line) => total + lineWeightKg(line), 0);
}

export function usesFallbackWeight(line: OwnStockLine) {
  return (line.weightSource ?? (productForLine(line) ? 'catalog' : 'fallback_15kg')) === 'fallback_15kg';
}
