import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  clientImportBatchSchema, clientImportPreviewSchema, clientImportsPath,
  clientImportsValidatePath, clientImportPath,
} from '@cirne/contracts';

async function sendFile(baseUrl: string, endpoint: string, token: string, filePath: string) {
  const bytes = await readFile(filePath);
  const form = new FormData();
  form.set('file', new File([bytes], path.basename(filePath), {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }));
  const response = await fetch(new URL(endpoint, baseUrl), {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form,
  });
  const body = await response.json() as unknown;
  if (!response.ok) throw new Error(`Importação respondeu HTTP ${response.status}.`);
  return body;
}
export async function runClientImportRoundTrip(baseUrl: string, token: string, filePath: string) {
  const preview = clientImportPreviewSchema.parse(await sendFile(baseUrl, clientImportsValidatePath, token, filePath));
  const first = clientImportBatchSchema.parse(await sendFile(baseUrl, clientImportsPath, token, filePath));
  const replay = clientImportBatchSchema.parse(await sendFile(baseUrl, clientImportsPath, token, filePath));
  const response = await fetch(new URL(clientImportPath(first.id), baseUrl), {
    headers: { authorization: `Bearer ${token}` }, cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Consulta do lote respondeu HTTP ${response.status}.`);
  const queried = clientImportBatchSchema.parse(await response.json());
  if (!replay.replayed || queried.id !== first.id) throw new Error('Reenvio idempotente não confirmado.');
  return { status: 'ok' as const, batchId: first.id, sourceChecksum: first.sourceChecksum,
    totalCount: first.totalCount, acceptedCount: first.acceptedCount, rejectedCount: first.rejectedCount,
    previewAcceptedCount: preview.acceptedCount, replayed: replay.replayed };
}
