import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import {
  productCatalogSyncFailRequestSchema,
  productCatalogSyncPublishRequestSchema,
  productCatalogSyncRequestSchema,
  productCatalogSyncResultSchema,
  productCatalogSyncStageRequestSchema,
  type MeResponse,
} from '@cirne/contracts';
import type { ProductCatalogProjectedRow } from '@cirne/domain';
import { expect, it, vi } from 'vitest';
import { productCatalogSyncCommand } from '../../apps/cli/src/product-catalog-sync';
import {
  beginProductCatalogSync,
  failProductCatalogSync,
  getProductCatalogSyncStatus,
  productCatalogSourceKey,
  publishProductCatalogSync,
  stageProductCatalogSync,
} from '../../apps/web/src/server/product-catalog-sync/service';
import { run, supabaseBinary } from '../../scripts/process';

const container = 'supabase_db_cirne-rotas-dev';
const viaWsl = process.platform === 'win32' && process.env.CIRNE_DOCKER_BACKEND === 'rancher-desktop-wsl';
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

function sql(input: string) {
  return new Promise<string>((resolve, reject) => {
    const child = execFile(viaWsl ? 'wsl' : 'docker', [
      ...(viaWsl ? ['-d', 'rancher-desktop', '--', 'docker'] : []),
      'exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'supabase_admin', '-d', 'postgres',
    ], { windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) reject(new Error('Falha na integração sintética do catálogo com o banco local.'));
      else resolve(stdout);
    });
    child.stdin?.end(input);
  });
}

const projectedRows = (description = 'Bateria sintética 60 Ah'): ProductCatalogProjectedRow[] => [{
  sourceRow: 2,
  cells: ['H-001', '123', 'Automotiva', description, 'H-001', '60AH', 'Heliar', 'Convencional', 'CV',
    '60', '440', '12', 'Direita', '14,2', '190×242×175', '242×175×190', '499,90', 'Veículos leves'],
}];

it('round-trips the CLI contract through the BFF service and authorized catalog SQL lifecycle', async () => {
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
  const spreadsheetId = `synthetic_product_catalog_${randomUUID().replaceAll('-', '')}`;
  const env = {
    GOOGLE_PRODUCT_CATALOG_ENABLED: 'true',
    GOOGLE_PRODUCT_CATALOG_SPREADSHEET_ID: spreadsheetId,
    GOOGLE_PRODUCT_CATALOG_ACTOR_ID: actor.id,
    GOOGLE_PRODUCT_CATALOG_SERVICE_ACCOUNT_EMAIL: 'test@synthetic.iam.gserviceaccount.com',
    GOOGLE_PRODUCT_CATALOG_PRIVATE_KEY: 'x'.repeat(100),
  };
  const sourceKey = productCatalogSourceKey({ spreadsheetId });
  const client = createClient(local.API_URL, local.PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const login = await client.auth.signInWithPassword({ email: actor.email, password: actor.password });
  expect(login.error).toBeNull();
  const identity: MeResponse = { id: login.data.user!.id, displayName: 'Gestor Sintético', roles: ['manager'],
    capabilities: ['products.sync'], scopeIds: [], status: 'active' };
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) as unknown : null;
    if (url.pathname === '/api/v1/product-catalog-sync') {
      return Response.json(await getProductCatalogSyncStatus(client, env));
    }
    if (url.pathname === '/api/v1/product-catalog-sync/runs') {
      return Response.json(await beginProductCatalogSync(client, identity,
        productCatalogSyncRequestSchema.parse(body), 'cli', env));
    }
    const match = url.pathname.match(/^\/api\/v1\/product-catalog-sync\/runs\/([^/]+)\/(stage|publish|fail)$/);
    if (!match) return Response.json({}, { status: 404 });
    const [, runId, action] = match;
    if (action === 'stage') return Response.json(await stageProductCatalogSync(client, runId!,
      productCatalogSyncStageRequestSchema.parse(body)));
    if (action === 'publish') return Response.json(await publishProductCatalogSync(client, runId!,
      productCatalogSyncPublishRequestSchema.parse(body)));
    return Response.json(await failProductCatalogSync(client, runId!, productCatalogSyncFailRequestSchema.parse(body)));
  };
  const readSheet = vi.fn(async () => projectedRows());
  const firstKey = randomUUID();
  let provisioned = false;
  try {
    await sql(`begin;
    do $$begin
      if exists(select 1 from private.product_catalog_sources) then raise exception 'catalog source already configured'; end if;
      if exists(select 1 from api.role_permissions where permission_code='products.sync') then raise exception 'capability already configured'; end if;
    end$$;
    insert into private.product_catalog_sources(source_key,sync_actor_id) values(${literal(sourceKey)},${literal(actor.id)}::uuid);
    insert into api.role_permissions(role_id,permission_code)
      select id,'products.sync' from api.roles where code='manager';
    commit;`);
    provisioned = true;
    const first = productCatalogSyncResultSchema.parse(await productCatalogSyncCommand('http://127.0.0.1:3000',
      login.data.session!.access_token, { trigger: 'manual', idempotencyKey: firstKey }, { env, transport, readSheet }));
    expect(first).toMatchObject({ status: 'published', sourceRowCount: 1, stagedRowCount: 1 });
    expect(readSheet).toHaveBeenCalledTimes(2);
    const replay = productCatalogSyncResultSchema.parse(await productCatalogSyncCommand('http://127.0.0.1:3000',
      login.data.session!.access_token, { trigger: 'manual', idempotencyKey: firstKey }, { env, transport, readSheet }));
    expect(replay).toEqual(first);
    expect(readSheet).toHaveBeenCalledTimes(2);
    const status = await productCatalogSyncCommand('http://127.0.0.1:3000', login.data.session!.access_token,
      null, { env, transport });
    expect(status).toMatchObject({ configured: true, scheduleEnabled: false,
      lastPublishedRun: { id: first.id, status: 'published' } });
    expect(JSON.parse((await sql(`select jsonb_build_object('runs',count(*),'items',
      (select count(*) from private.product_catalog_snapshot_items where run_id=${literal(first.id)}::uuid),
      'price',(select market_average_price from private.product_catalog_snapshot_items
        where run_id=${literal(first.id)}::uuid limit 1))
      from private.product_catalog_sync_runs where source_key=${literal(sourceKey)};`)).trim()) as unknown)
      .toEqual({ runs: 1, items: 1, price: '499,90' });
  } finally {
    if (provisioned) await sql(`begin;
      update private.product_catalog_sources set published_run_id=null where source_key=${literal(sourceKey)};
      delete from private.product_catalog_sales_diagnostics where catalog_run_id in
        (select id from private.product_catalog_sync_runs where source_key=${literal(sourceKey)});
      delete from private.product_catalog_snapshot_items where run_id in
        (select id from private.product_catalog_sync_runs where source_key=${literal(sourceKey)});
      delete from private.product_catalog_sync_chunks where run_id in
        (select id from private.product_catalog_sync_runs where source_key=${literal(sourceKey)});
      delete from private.product_catalog_sync_runs where source_key=${literal(sourceKey)};
      delete from private.product_catalog_sources where source_key=${literal(sourceKey)};
      delete from api.role_permissions where permission_code='products.sync';
      commit;`);
    await client.auth.signOut({ scope: 'local' });
  }
  expect((await sql(`select count(*) from private.product_catalog_sources where source_key=${literal(sourceKey)};`)).trim()).toBe('0');
});
