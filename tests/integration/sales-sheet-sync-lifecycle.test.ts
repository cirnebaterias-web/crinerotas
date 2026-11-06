import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { clientSalesPageSchema, clientSalesProductsPageSchema, salesSignalBatchSchema, salesSyncResultSchema } from '@cirne/contracts';
import { calculateClientSales, normalizeSalesRows, salesMetricsFromStats, salesRowTuple, type SalesProjectedRow } from '@cirne/domain';

const container = 'supabase_db_cirne-rotas-dev';
const viaWsl = process.platform === 'win32' && process.env.CIRNE_DOCKER_BACKEND === 'rancher-desktop-wsl';
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
function sql(input: string) {
  return new Promise<string>((resolve, reject) => {
    const child = execFile(viaWsl ? 'wsl' : 'docker', [
      ...(viaWsl ? ['-d', 'rancher-desktop', '--', 'docker'] : []),
      'exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=sqlstate', '-U', 'postgres', '-d', 'postgres',
    ], { windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      // Input and DB error detail can contain rows: deliberately never include them in diagnostics.
      if (error) reject(new Error(`Falha na integração sintética de vendas com o banco local (${stderr.match(/ERROR:\s+([A-Z0-9]{5})\b/)?.[1] ?? 'TRANSPORT'}).`));
      else resolve(stdout);
    });
    child.stdin?.end(input);
  });
}

it('round-trips normalized JS tuples through authorized SQL snapshots and preserves corrected generations', async () => {
  const manifest = JSON.parse(await readFile('.local/identity-actors.json', 'utf8')) as {
    actors: Record<string, { id: string }>;
  };
  const manager = manifest.actors.manager_a!.id;
  const seller = manifest.actors.seller_a!.id;
  for (const id of [manager, seller]) if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Identidade sintética inválida.');
  const clientId = randomUUID();
  const source = digest(`synthetic_sales_${randomUUID()}`);
  const first: SalesProjectedRow[] = [{ sourceRow: 2, cells: {
    clientExternalReference: '00.000.000/0001-91', invoiceNumber: 'NF-0001', saleDate: '5/10/2026',
    sku: '0001', volume: '3', totalAmount: '370,35', productDescription: 'Bateria Çafé "Ω" \\ / 你好',
    itemGroup: 'SLI', itemSubgroup: '', category: 'Leve', brand: 'Sintética', line: '', kind: 'Venda', externalKey: 'TEST-A',
  } }];
  first.push({ sourceRow: 3, cells: { ...first[0]!.cells, externalKey: 'TEST-B', saleDate: '6/10/2026',
    sku: '0002', volume: '-1', totalAmount: '-123,45', kind: 'Devolução' } });
  const oldRows = normalizeSalesRows(first);
  const newRows = normalizeSalesRows([{ ...first[0]!, cells: { ...first[0]!.cells, volume: '5', totalAmount: '617,25' } }]);
  const hash = (rows: typeof oldRows) => digest(rows.map((row) => digest(JSON.stringify(salesRowTuple(row)))).join(''));
  const publication = (rows: typeof oldRows, variable: string) => `
    select api.begin_sales_sheet_sync('${source}','${randomUUID()}','manual') as begun \\gset
    select api.stage_sales_sheet_sync(((:'begun')::jsonb->>'runId')::uuid,
      ((:'begun')::jsonb->>'leaseToken')::uuid,0,'${hash(rows)}',${literal(JSON.stringify(rows))}::jsonb) as staged \\gset
    select api.publish_sales_sheet_sync(((:'begun')::jsonb->>'runId')::uuid,
      ((:'begun')::jsonb->>'leaseToken')::uuid,'${hash(rows)}',${rows.length},1) as ${variable} \\gset
    select jsonb_build_object('event','${variable}','payload',(:'${variable}')::jsonb);
  `;
  // The source/actor binding and all facts exist only inside this rollback transaction.
  // Never interfere with an already provisioned integration or import real source data.
  const output = await sql(`begin;
    do $$begin if exists(select 1 from private.sales_sources) then
      raise exception 'Local source must be unconfigured for isolated synthetic check'; end if; end$$;
    insert into api.clients(id,external_reference,name,address)
      values('${clientId}','00000000000191','Cliente integração vendas TESTE','Endereço sintético');
    insert into api.client_seller_scopes(client_id,seller_id,assigned_by) values('${clientId}','${seller}','${manager}');
    insert into private.sales_sources(source_key,scheduler_actor_id) values('${source}','${manager}');
    set local role authenticated;
    select set_config('request.jwt.claim.sub','${manager}',true) as actor \\gset
    ${publication(oldRows, 'first')}
    select jsonb_build_object('event','firstSignals','payload',api.get_sales_route_signals('${seller}',array['${clientId}']::uuid[]));
    select set_config('request.jwt.claim.sub','${seller}',true) as actor \\gset
    select jsonb_build_object('event','firstPage','payload',api.get_client_sales_page('${clientId}'));
    select jsonb_build_object('event','products','payload',api.get_client_sales_products('${clientId}',((:'first')::jsonb->>'id')::uuid));
    select set_config('request.jwt.claim.sub','${manager}',true) as actor \\gset
    ${publication(newRows, 'second')}
    select jsonb_build_object('event','secondSignals','payload',api.get_sales_route_signals('${seller}',array['${clientId}']::uuid[]));
    select jsonb_build_object('event','replay','payload',api.publish_sales_sheet_sync(
      ((:'begun')::jsonb->>'runId')::uuid,((:'begun')::jsonb->>'leaseToken')::uuid,'${hash(newRows)}',1,1));
    select set_config('request.jwt.claim.sub','${seller}',true) as actor \\gset
    select jsonb_build_object('event','secondPage','payload',api.get_client_sales_page('${clientId}'));
    reset role;
    do $$begin execute format('grant cirne_route_executor to %I with set true granted by current_user',current_user); end$$;
    set local role cirne_route_executor;
    select jsonb_build_object('event','retained','payload',jsonb_build_object(
      'generations',(select count(*) from private.sales_sync_runs where source_key='${source}' and status='published'),
      'oldRows',(select count(*) from private.sales_snapshot_lines where run_id=((:'first')::jsonb->>'id')::uuid),
      'oldVolume',(select sum(volume) from private.sales_snapshot_lines where run_id=((:'first')::jsonb->>'id')::uuid)));
    rollback;
  `);
  const events = Object.fromEntries(output.split(/\r?\n/).filter((line) => line.startsWith('{')).map((line) => {
    const event = JSON.parse(line) as { event: string; payload: unknown };
    return [event.event, event.payload];
  }));
  const firstResult = salesSyncResultSchema.parse(events.first);
  const secondResult = salesSyncResultSchema.parse(events.second);
  expect(firstResult).toMatchObject({ status: 'published', sourceRowCount: 2, contentHash: hash(oldRows) });
  expect(secondResult).toMatchObject({ status: 'published', sourceRowCount: 1, contentHash: hash(newRows) });
  expect(secondResult.generationId).not.toBe(firstResult.generationId);
  expect(events.replay).toEqual(events.second);
  const oldPage = clientSalesPageSchema.parse(events.firstPage);
  expect(oldPage.rows.map((row) => [row.volume, row.totalAmount])).toEqual([[3, '370.35'], [-1, '-123.45']]);
  expect(oldPage.rows[0]?.productDescription).toBe(oldRows[0]?.productDescription);
  const newPage = clientSalesPageSchema.parse(events.secondPage);
  expect(newPage.generationId).toBe(secondResult.generationId);
  expect(newPage.rows).toHaveLength(1);
  expect(newPage.rows[0]?.volume).toBe(5);
  const products = clientSalesProductsPageSchema.parse(events.products);
  expect(products.products.map((product) => product.sku)).toEqual(['0001', '0002']);
  expect(products).toMatchObject({ generationId: oldPage.generationId,
    asOfDate: oldPage.asOfDate, clientVersion: oldPage.clientVersion });
  const { nextAfterRow: firstCursor, ...firstSnapshot } = oldPage;
  expect(firstCursor).toBeNull();
  const detail = calculateClientSales(firstSnapshot,
    { historyPage: 1, opportunityPage: 1 }, new Date(oldPage.publishedAt));
  const firstSignals = salesSignalBatchSchema.parse(events.firstSignals);
  expect(firstSignals).toMatchObject({ generationId: oldPage.generationId, asOfDate: oldPage.asOfDate, sellerId: seller });
  expect(firstSignals.signals).toHaveLength(1);
  expect(salesMetricsFromStats(firstSignals.signals[0]!, firstSignals.asOfDate)).toEqual(detail.metrics);
  const secondSignals = salesSignalBatchSchema.parse(events.secondSignals);
  const { nextAfterRow: secondCursor, ...secondSnapshot } = newPage;
  expect(secondCursor).toBeNull();
  expect(secondSignals.generationId).toBe(newPage.generationId);
  expect(salesMetricsFromStats(secondSignals.signals[0]!, secondSignals.asOfDate)).toEqual(
    calculateClientSales(secondSnapshot,
      { historyPage: 1, opportunityPage: 1 }, new Date(newPage.publishedAt)).metrics,
  );
  expect(events.retained).toEqual({ generations: 2, oldRows: 2, oldVolume: 2 });
  expect((await sql('select count(*) from private.sales_sources;')).trim()).toBe('0');
});
