import { clientImportPreviewSchema, type ClientImportPreview } from '@cirne/contracts';
import type { SupabaseClient } from '@supabase/supabase-js';
import { clientImportRpc } from './http';

export async function validateImportSellers(client: SupabaseClient, preview: ClientImportPreview) {
  if (preview.rows.length === 0) return preview;
  const invalid = await clientImportRpc(client, 'validate_client_import_sellers', {
    p_emails: [...new Set(preview.rows.map((row) => row.sellerEmail))],
  });
  const invalidSet = new Set(Array.isArray(invalid) ? invalid.filter((value): value is string => typeof value === 'string') : []);
  if (invalidSet.size === 0) return preview;
  const invalidRows = preview.rows.filter((row) => invalidSet.has(row.sellerEmail));
  const rows = preview.rows.filter((row) => !invalidSet.has(row.sellerEmail));
  const issues = [...preview.issues, ...invalidRows.map((row) => ({ rowNumber: row.rowNumber,
    code: 'SELLER_NOT_FOUND', message: 'Vendedor inexistente, inativo ou sem papel de Vendedor.' }))];
  const rejectedCount = new Set(issues.filter((item) => item.rowNumber > 1).map((item) => item.rowNumber)).size;
  return clientImportPreviewSchema.parse({ ...preview, rows, issues,
    totalCount: rows.length + rejectedCount, acceptedCount: rows.length, rejectedCount });
}
