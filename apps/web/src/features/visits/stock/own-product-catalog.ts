import type { OwnStockLine } from '@cirne/contracts';

export const OWN_STOCK_BRANDS = ['Heliar', 'América', 'Durex', 'ACDelco'] as const;
export type OwnStockBrand = typeof OWN_STOCK_BRANDS[number];

export const ownProductCatalog: Record<OwnStockBrand, string[]> = {
  Heliar: ['HG38JD 24-320', 'HTZ12S-BS', 'H38JD 24-320', 'H40JD 24-320', 'H40JD JIS 24-300', 'HNP45BD 24-330', 'HG45BE 24-330', 'HG45BD H 24M', 'H45JE 24-340', 'HE48BD 24-375'],
  América: ['AM38JD 18-300', 'AMR45BD 18-310', 'AM45JD 18-340', 'AMR50GD 18-370', 'AMR60DD 18-375', 'AMR60HD 18-375', 'AMR70ND 18-450', 'AM75LD 18-500', 'AM90LD 18-690', 'AMF150TD 15-800'],
  Durex: ['ST50GD 12-370', 'ST60DD 12-375', 'ST70ND 12-450', 'ST100LE 12-640', 'ST50DD 12-375', 'D60DD 12-400'],
  ACDelco: ['ADS52GD 24-450', 'ADS60DD 24-480', 'ADS48BD 24-375', 'ADR60DD 18-425', 'ADR50JD A 18 M', 'ADS60HD 24-480', 'ADR60HD 18-425', 'ADS70ND 24-660', 'ADR70ND 18-500', 'ADS75PD 24-620'],
};

export function ownLinesForBrand(lines: OwnStockLine[] | undefined, brand: OwnStockBrand) {
  return (lines ?? []).filter((line) => line.brand === brand);
}
