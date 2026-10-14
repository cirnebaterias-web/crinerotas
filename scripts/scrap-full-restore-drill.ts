import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { root, run, supabaseBinary } from './process';
import { verifyBackupManifest } from './backup-verify';

type LocalStatus = { API_URL: string; SECRET_KEY: string };
type EvidenceRow = { storagePath: string; byteSize: number; sha256: string };

const container = 'supabase_db_cirne-rotas-dev';
const schemas = ['auth', 'api', 'private', 'storage', 'supabase_migrations'];
const countTables = [
  'auth.users', 'api.clients', 'api.client_seller_scopes', 'api.scrap_collections',
  'api.scrap_receipts', 'api.scrap_attachments', 'api.pickup_schedules',
  'api.pickup_schedule_revisions', 'private.audit_events', 'storage.buckets', 'storage.objects',
];

function docker(args: string[], timeout = 120_000) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('docker', args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill(), timeout);
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`Docker encerrou com código ${code ?? 'desconhecido'}: ${stderr.trim()}`));
    });
  });
}

async function psql(database: string, sql: string, user = 'supabase_admin') {
  return (await docker(['exec', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
    '-U', user, '-d', database, '-c', sql])).trim();
}

async function dumpDatabase(destination: string) {
  const args = ['exec', container, 'pg_dump', '-U', 'supabase_admin', '-d', 'postgres',
    '--no-owner', '--no-publications', '--no-subscriptions',
    ...schemas.flatMap((schema) => ['--schema', schema])];
  const child = spawn('docker', args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  const output = createWriteStream(destination, { flags: 'wx', mode: 0o600 });
  let code: number | null;
  try {
    const [, [exitCode]] = await Promise.all([
      pipeline(child.stdout, output),
      Promise.race([
        once(child, 'close') as Promise<[number | null]>,
        once(child, 'error').then(([error]) => {
          throw error;
        }),
      ]),
    ]);
    code = exitCode;
  } catch (error) {
    child.kill();
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Não foi possível gerar o dump via Docker: ${message}`);
  }
  if (code !== 0) throw new Error(`pg_dump falhou: ${stderr.trim()}`);
}

async function restoreDatabase(database: string, source: string) {
  const child = spawn('docker', ['exec', '-i', container, 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1',
    '-U', 'supabase_admin', '-d', database],
  { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  let code: number | null;
  try {
    const [, [exitCode]] = await Promise.all([
      pipeline(createReadStream(source), child.stdin),
      Promise.race([
        once(child, 'close') as Promise<[number | null]>,
        once(child, 'error').then(([error]) => {
          throw error;
        }),
      ]),
    ]);
    code = exitCode;
  } catch (error) {
    child.kill();
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Não foi possível restaurar o dump via Docker: ${message}`);
  }
  if (code !== 0) throw new Error(`Restauração SQL falhou: ${stderr.trim()}`);
}

async function sha256(file: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function safeObjectPath(storagePath: string) {
  const parts = storagePath.split('/');
  if (!storagePath || storagePath.includes('\\') || parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Caminho de objeto inseguro no Storage.');
  }
  return parts;
}

async function downloadEvidence(status: LocalStatus, directory: string, row: EvidenceRow) {
  const parts = safeObjectPath(row.storagePath);
  const response = await fetch(`${status.API_URL}/storage/v1/object/authenticated/scrap-evidence/${parts.map(encodeURIComponent).join('/')}`, {
    headers: { apikey: status.SECRET_KEY, Authorization: `Bearer ${status.SECRET_KEY}` },
  });
  if (!response.ok || !response.body) throw new Error(`Falha ao baixar evidência sintética (${response.status}).`);
  const relativePath = ['objects', ...parts].join('/');
  const absolutePath = path.join(directory, ...relativePath.split('/'));
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await pipeline(response.body, createWriteStream(absolutePath, { flags: 'wx', mode: 0o600 }));
  const info = await stat(absolutePath);
  const digest = await sha256(absolutePath);
  if (info.size !== row.byteSize || digest !== row.sha256) {
    throw new Error('Bytes recuperados do Storage divergem do registro verificado.');
  }
  return { storagePath: row.storagePath, path: relativePath, byteSize: info.size, sha256: digest };
}

async function main() {
  const statusResult = await run(supabaseBinary, ['status', '-o', 'json'], 120_000);
  if (!statusResult.ok) throw new Error('Supabase local indisponível.');
  const status = JSON.parse(statusResult.output) as LocalStatus;
  if (!status.API_URL || !status.SECRET_KEY) throw new Error('Status local sem credenciais operacionais.');

  const rows = JSON.parse(await psql('postgres', `select coalesce(json_agg(json_build_object(
    'storagePath',storage_path,'byteSize',byte_size,'sha256',checksum) order by storage_path),'[]'::json)
    from api.scrap_attachments where status='verified';`)) as EvidenceRow[];
  if (rows.length === 0) throw new Error('O ensaio exige ao menos uma evidência sintética verificada.');

  const stamp = new Date().toISOString().replaceAll(':', '').replaceAll('-', '').replace(/\.\d{3}Z$/, 'Z');
  const directory = path.join(root, '.local', `scrap-full-restore-drill-${stamp}`);
  await mkdir(directory, { recursive: false, mode: 0o700 });
  const dumpPath = path.join(directory, 'database.sql');
  const target = `cirne_scrap_restore_${randomUUID().replaceAll('-', '')}`;
  if (!/^cirne_scrap_restore_[0-9a-f]{32}$/.test(target)) throw new Error('Nome de alvo inseguro.');

  try {
    await dumpDatabase(dumpPath);
    const objects = [];
    for (const row of rows) objects.push(await downloadEvidence(status, directory, row));
    const dumpInfo = await stat(dumpPath);
    const databaseMigration = await psql('postgres',
      "select version from supabase_migrations.schema_migrations order by version desc limit 1;");
    const manifestPath = path.join(directory, 'manifest.json');
    await writeFile(manifestPath, `${JSON.stringify({
      schemaVersion: 1,
      databaseMigration,
      capturedAt: new Date().toISOString(),
      database: { path: 'database.sql', byteSize: dumpInfo.size, sha256: await sha256(dumpPath) },
      scrapEvidence: { bucket: 'scrap-evidence', expectedObjectCount: objects.length, objects },
    }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    const packageVerification = await verifyBackupManifest(manifestPath);

    await psql('postgres', `create database ${target} owner postgres;`);
    await psql(target, `create schema extensions;
      create extension if not exists pgcrypto with schema extensions;
      create extension if not exists postgis with schema extensions;
      create extension if not exists "uuid-ossp" with schema extensions;`);
    await restoreDatabase(target, dumpPath);

    const sourceCounts = await psql('postgres', `select jsonb_object_agg(name,count) from (${countTables.map((table) =>
      `select '${table}' name,count(*) count from ${table}`).join(' union all ')}) counts;`);
    const targetCounts = await psql(target, `select jsonb_object_agg(name,count) from (${countTables.map((table) =>
      `select '${table}' name,count(*) count from ${table}`).join(' union all ')}) counts;`);
    if (sourceCounts !== targetCounts) throw new Error('Contagens do banco restaurado divergem da origem.');

    const sellerId = await psql(target,
      "select id from auth.users where raw_user_meta_data->>'actorKey'='seller_a' limit 1;");
    if (!sellerId) throw new Error('Identidade Auth sintética não foi restaurada.');
    const identity = await psql(target, `begin; set local role authenticated;
      select set_config('request.jwt.claim.sub','${sellerId}',true);
      select api.get_my_identity()->>'id'; rollback;`);
    if (!identity.split(/\r?\n/).includes(sellerId)) throw new Error('Auth/RLS restaurados não resolveram o ator sintético.');

    const controls = await psql(target, `select
      to_regprocedure('api.search_scrap_clients(text,integer)') is not null
      and to_regprocedure('private.scrap_client_authorized(uuid,uuid)') is not null
      and (select relrowsecurity and relforcerowsecurity from pg_class where oid='api.client_seller_scopes'::regclass)
      and exists(select 1 from storage.buckets where id='scrap-evidence' and not public);`);
    if (controls !== 't') throw new Error('Funções, RLS ou bucket privado não foram restaurados integralmente.');

    const report = {
      status: 'pass', targetDatabase: target, manifestPath,
      restoredSchemas: schemas, packageVerification,
      counts: JSON.parse(targetCounts), identityRestored: true, rlsRestored: true,
      privateBucketRestored: true, evidenceObjectsVerified: objects.length,
    };
    await writeFile(path.join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 });
    console.log(JSON.stringify(report));
  } finally {
    await psql('postgres',
      `select pg_terminate_backend(pid) from pg_stat_activity where datname='${target}';`).catch(() => undefined);
    await psql('postgres', `drop database if exists ${target};`).catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Ensaio integral falhou.');
  process.exitCode = 1;
});
