import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { assertProjectIdentity, projectId } from './local-settings';
import { root, run } from './process';

// Exercise the actual migration bodies inside one disposable transaction.
// Only their outer transaction delimiters are removed; all DDL/data stays intact.
async function migrationBody(relativePath: string) {
  const sql = await readFile(path.join(root, relativePath), 'utf8');
  if (!/^begin;\s/i.test(sql) || !/\scommit;\s*$/i.test(sql)) {
    throw new Error('Migração sem delimitadores transacionais esperados.');
  }
  return sql.replace(/^begin;\s*/i, '').replace(/\scommit;\s*$/i, '');
}

async function verify() {
  assertProjectIdentity();
  if (process.env.DOCKER_HOST && !/^(unix:\/\/|npipe:\/\/)/.test(process.env.DOCKER_HOST)) {
    throw new Error('DOCKER_HOST remoto não é permitido neste teste local.');
  }
  const context = await run('docker', ['context', 'inspect']);
  const host: unknown = context.ok ? JSON.parse(context.output)[0]?.Endpoints?.docker?.Host : null;
  if (typeof host !== 'string' || !/^(unix:\/\/|npipe:\/\/)/.test(host)) {
    throw new Error('Docker local indisponível.');
  }
  const [rollback, migration] = await Promise.all([
    migrationBody('supabase/rollbacks/20260916190000_route_execution_order.rollback.sql'),
    migrationBody('supabase/migrations/20260916190000_route_execution_order.sql'),
  ]);
  const snapshot = `jsonb_build_object(
    'routes', (select jsonb_agg(to_jsonb(t) order by id) from api.routes t),
    'versions', (select jsonb_agg(to_jsonb(t) order by id) from api.route_versions t),
    'stops', (select jsonb_agg(to_jsonb(t) order by id) from api.route_version_stops t),
    'executions', (select jsonb_agg(to_jsonb(t) order by id) from api.route_stop_executions t),
    'audit', (select jsonb_agg(to_jsonb(t) order by id) from private.audit_events t))`;
  const sql = `begin;
    set local statement_timeout = '30s';
    create temp table rollback_snapshot as select ${snapshot} as document;
    ${rollback}
    do $verify_rollback$ begin
      if to_regprocedure('api.reorder_route_execution(uuid,jsonb,uuid,text)') is not null
        or exists (select 1 from pg_constraint where conrelid = 'api.route_stop_executions'::regclass
          and conname = 'route_stop_executions_order_key' and condeferrable)
        or exists (select 1 from api.role_permissions where permission_code like 'route.reorder_%') then
        raise exception 'Rollback did not restore the previous interface';
      end if;
      if (${snapshot}) is distinct from (select document from rollback_snapshot) then
        raise exception 'Rollback changed stored route or audit data';
      end if;
    end $verify_rollback$;
    ${migration}
    do $verify_reapply$ begin
      if to_regprocedure('api.reorder_route_execution(uuid,jsonb,uuid,text)') is null
        or not exists (select 1 from pg_constraint where conrelid = 'api.route_stop_executions'::regclass
          and conname = 'route_stop_executions_order_key' and condeferrable and not condeferred)
        or (select count(*) from api.role_permissions where permission_code like 'route.reorder_%') <> 2 then
        raise exception 'Reapplication did not restore the execution order interface';
      end if;
      if (${snapshot}) is distinct from (select document from rollback_snapshot) then
        raise exception 'Reapplication changed stored route or audit data';
      end if;
    end $verify_reapply$;
    rollback;`;
  await new Promise<void>((resolve, reject) => {
    const child = spawn('docker', [
      'exec', '-i', `supabase_db_${projectId}`, 'psql', '-X', '-U', 'postgres', '-d', 'postgres',
      '-v', 'ON_ERROR_STOP=1',
    ], { cwd: root, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    let errors = '';
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { errors += chunk; });
    child.once('error', reject);
    child.stdin.on('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Falha no ensaio de rollback: ${errors}`));
    });
    child.stdin.end(sql);
  });
  console.log('Rollback e reaplicação validados; rotas, execuções e auditoria preservadas. Ensaio revertido.');
}

verify().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Falha no ensaio local de rollback.');
  process.exitCode = 1;
});
