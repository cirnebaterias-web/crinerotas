import { randomInt, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import { clientListResponseSchema, clientSheetHeaders, type MeResponse } from '@cirne/contracts';
import { expect, it, vi } from 'vitest';
import { getClientSheetSyncStatus, synchronizeClientSheet } from '../../apps/web/src/server/client-sheet-sync/service';
import { run, supabaseBinary } from '../../scripts/process';

it('normalizes a synthetic sheet through the real caller-scoped database, preserving excluded clients and replaying results', async () => {
  // Match the CI/local integration harness; CI does not create apps/web/.env.local.
  const statusResult = await run(supabaseBinary, ['status', '-o', 'json'], 30_000);
  if (!statusResult.ok) throw new Error('Supabase local indisponível para o teste sintético.');
  const local = JSON.parse(statusResult.output) as Record<string, unknown>;
  if (typeof local.API_URL !== 'string' || typeof local.PUBLISHABLE_KEY !== 'string') {
    throw new Error('Configuração pública local incompatível.');
  }
  const manifest = JSON.parse(await readFile('.local/identity-actors.json', 'utf8')) as {
    actors: Record<string, { id: string; email: string; password: string }>;
  };
  const actor = manifest.actors.manager_a!;
  const seller = manifest.actors.seller_a!;
  const client = createClient(local.API_URL, local.PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const login = await client.auth.signInWithPassword({ email: actor.email, password: actor.password });
  expect(login.error).toBeNull();
  const identity: MeResponse = { id: login.data.user!.id, displayName: 'Gestor Sintético',
    roles: ['manager'], capabilities: ['clients.import'], scopeIds: [], status: 'active' };
  const env = { GOOGLE_CLIENT_SYNC_ENABLED: 'true',
    GOOGLE_CLIENT_SYNC_SPREADSHEET_ID: `synthetic_${randomUUID()}`,
    GOOGLE_CLIENT_SYNC_SERVICE_ACCOUNT_EMAIL: 'test@synthetic.iam.gserviceaccount.com',
    GOOGLE_CLIENT_SYNC_PRIVATE_KEY: 'synthetic-placeholder-not-used'.repeat(6),
    GOOGLE_CLIENT_SYNC_PORTFOLIOS_JSON: JSON.stringify({ TESTE: seller.email }) };
  const refs = Array.from({ length: 3 }, () => String(randomInt(10 ** 13, 10 ** 14)));
  const googleLocation = { address: 'Rua Google Sintética, 422', placeId: 'EjR_synthetic-422',
    status: 'REVISAR_ENDERECO_PARCIAL', precision: 'RANGE_INTERPOLATED' };
  const row = (index: number, portfolio: string, status: string, name = 'Cliente Google Sintético TESTE') =>
    [name, refs[index]!, '', portfolio, status, '', '', '', '', 'Rua Sintética, 313',
      '', '', '', '', '', googleLocation.status, googleLocation.address, googleLocation.precision, '', '', googleLocation.placeId];
  const readSheet = vi.fn().mockResolvedValue([[...clientSheetHeaders],
    row(0, 'TESTE', 'ATIVO'), row(1, 'TESTE', ''), row(2, 'OUTROS', '')]);
  const command = { trigger: 'manual', idempotencyKey: randomUUID() } as const;
  const first = await synchronizeClientSheet(client, identity, command, 'cli', { env, readSheet });
  expect(first).toMatchObject({ status: 'completed_with_pending', acceptedCount: 1, pendingCount: 1, ignoredCount: 1 });
  expect(first.issues).toEqual([expect.objectContaining({ rowNumber: 3, code: 'STATUS_PENDING_REVIEW' })]);
  const replay = await synchronizeClientSheet(client, identity, command, 'cli', { env, readSheet });
  expect(replay).toEqual(first);
  expect(readSheet).toHaveBeenCalledTimes(1);
  expect((await getClientSheetSyncStatus(client, env)).latest).toEqual(first);

  async function stored() {
    const responses = await Promise.all(refs.map(async (reference) => {
      const { data, error } = await client.schema('api').rpc('list_management_clients', {
        p_query: reference, p_page: 1, p_page_size: 25, p_seller_id: null,
      });
      expect(error).toBeNull();
      return clientListResponseSchema.parse(data).clients;
    }));
    return responses.flat();
  }
  let before = await stored();
  expect(before).toHaveLength(1);
  expect(before[0]?.status).toBe('active');
  expect(before[0]).toMatchObject({ address: 'Rua Sintética, 313', latitude: null, longitude: null, googleLocation });
  // A new manual request intentionally reapplies the source; only the same request key replays.
  await synchronizeClientSheet(client, identity, { ...command, idempotencyKey: randomUUID() }, 'cli', { env, readSheet });
  const refreshed = await stored();
  expect(refreshed).toEqual(before.map((entry) => ({ ...entry, version: entry.version + 1 })));
  before = refreshed;
  readSheet.mockResolvedValue([[...clientSheetHeaders], row(0, 'OUTROS', 'INATIVO', 'Não aplicar TESTE')]);
  const ignored = await synchronizeClientSheet(client, identity, { ...command, idempotencyKey: randomUUID() }, 'cli', { env, readSheet });
  expect(ignored).toMatchObject({ status: 'completed', acceptedCount: 0, pendingCount: 0, ignoredCount: 1 });
  expect(await stored()).toEqual(before);
  readSheet.mockResolvedValue([[...clientSheetHeaders]]);
  await synchronizeClientSheet(client, identity, { ...command, idempotencyKey: randomUUID() }, 'cli', { env, readSheet });
  expect(await stored()).toEqual(before);
  readSheet.mockResolvedValue([[...clientSheetHeaders], row(0, 'TESTE', 'INATIVO')]);
  const archived = await synchronizeClientSheet(client, identity, { ...command, idempotencyKey: randomUUID() }, 'cli', { env, readSheet });
  expect(archived).toMatchObject({ status: 'completed', acceptedCount: 1 });
  expect((await stored())[0]).toMatchObject({ id: before[0]!.id, status: 'archived' });
  await client.auth.signOut({ scope: 'local' });
});
