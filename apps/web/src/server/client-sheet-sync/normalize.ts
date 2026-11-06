import { createHash } from 'node:crypto';
import { normalizePortfolio } from '@cirne/config/client-sheet-sync';
import { clientSheetHeaders, clientImportPreviewSchema, clientImportRowSchema, clientGoogleLocationSchema,
  normalizeClientExternalReference, type ClientImportIssue, type ClientImportRow } from '@cirne/contracts';
import { RouteRequestError } from '../routes/http';

function text(value: unknown) { return typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : ''; }
function coordinate(value: unknown) {
  const raw = text(value);
  if (!raw) return null;
  return /^-?\d+(?:[.,]\d+)?$/.test(raw) ? Number(raw.replace(',', '.')) : NaN;
}
export function normalizeClientSheet(values: unknown[][], portfolios: Record<string, string>) {
  if (values.length > 5001 || !clientSheetHeaders.every((header, index) =>
    normalizePortfolio(text(values[0]?.[index])) === normalizePortfolio(header))) {
    throw new RouteRequestError(422, 'VALIDATION_FAILED', 'Confira os 21 cabeçalhos da aba Base clientes e o limite de 5.000 linhas.', false);
  }
  const issues: ClientImportIssue[] = [];
  const rows: ClientImportRow[] = [];
  let ignoredCount = 0;
  const references = new Map<string, number>();
  const candidates = values.slice(1).map((cells, index) => ({ cells, rowNumber: index + 2 }))
    .filter(({ cells }) => cells.some((value) => text(value) !== ''))
    .filter(({ cells }) => {
      if (normalizePortfolio(text(cells[3])) !== 'OUTROS') return true;
      ignoredCount += 1; return false;
    });
  for (const { cells } of candidates) {
    const reference = normalizeClientExternalReference(text(cells[1]));
    references.set(reference, (references.get(reference) ?? 0) + 1);
  }
  for (const { cells, rowNumber } of candidates) {
    const before = issues.length;
    const addIssue = (code: string, message: string) => {
      if (issues.length - before < 2) issues.push({ rowNumber, code, message });
    };
    const portfolio = text(cells[3]);
    const portfolioKey = normalizePortfolio(portfolio);
    const status = normalizePortfolio(text(cells[4]));
    const sellerEmail = Object.hasOwn(portfolios, portfolioKey) ? portfolios[portfolioKey] : undefined;
    if (!['ATIVO', 'INATIVO'].includes(status)) addIssue('STATUS_PENDING_REVIEW', 'Corrija o status na planilha para ATIVO ou INATIVO.');
    if (!portfolioKey || portfolioKey === 'VERIFICAR' || !sellerEmail) {
      addIssue('PORTFOLIO_PENDING_REVIEW', 'Defina a carteira na planilha e seu vínculo com um vendedor autorizado.');
    }
    const externalReference = normalizeClientExternalReference(text(cells[1]));
    if (!/^\d{11}(?:\d{3})?$/.test(externalReference)) addIssue('INVALID_REFERENCE', 'Informe CPF/CNPJ completo, preservando os zeros iniciais.');
    if ((references.get(externalReference) ?? 0) > 1) addIssue('DUPLICATE_REFERENCE', 'CPF/CNPJ repetido na fonte; revise todas as ocorrências.');
    if ([cells[0], cells[1], cells[3], cells[9]].some((value) => /^[=+\-@]/.test(text(value)))) {
      addIssue('UNSAFE_TEXT', 'Revise o conteúdo textual desta linha.');
    }
    const latitude = coordinate(cells[7]);
    const longitude = coordinate(cells[8]);
    if ((latitude === null) !== (longitude === null)) addIssue('INVALID_COORDINATES', 'Informe latitude e longitude juntas ou deixe ambas vazias.');
    const googleLocation = {
      address: text(cells[16]) || null, placeId: text(cells[20]) || null,
      status: text(cells[15]) || null, precision: text(cells[17]) || null,
    };
    if (!clientGoogleLocationSchema.safeParse(googleLocation).success ||
        [cells[15], cells[16], cells[17], cells[20]].some((value) =>
          (value !== null && typeof value === 'object') || /^[=+@]/.test(text(value)))) {
      addIssue('GOOGLE_LOCATION_PENDING_REVIEW', 'Revise endereço Google, Place ID, status geo e precisão desta linha.');
    }
    const parsed = clientImportRowSchema.safeParse({ rowNumber, externalReference,
      name: text(cells[0]), address: text(cells[9]), latitude, longitude, googleLocation,
      portfolioReference: portfolio || null, sellerEmail, status: status === 'ATIVO' ? 'active' : 'archived' });
    if (!parsed.success && issues.length === before) addIssue('INVALID_ROW', 'Revise nome, endereço, coordenadas e vendedor desta linha.');
    if (parsed.success && issues.length === before) rows.push(parsed.data);
  }
  const rejectedCount = new Set(issues.map((issue) => issue.rowNumber)).size;
  return { ignoredCount, preview: clientImportPreviewSchema.parse({
    schemaVersion: 1, sourceName: 'Google Sheets - Base clientes',
    sourceChecksum: createHash('sha256').update(JSON.stringify({ values, portfolios })).digest('hex'),
    totalCount: rows.length + rejectedCount, acceptedCount: rows.length, rejectedCount, rows, issues,
  }) };
}
