import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { assertProjectIdentity, projectId } from './local-settings';
import { root, run } from './process';

async function migrationBody(relativePath: string) {
  const sql = await readFile(path.join(root, relativePath), 'utf8');
  if (!/^begin;\s/i.test(sql) || !/\scommit;\s*$/i.test(sql)) {
    throw new Error('Migration without the expected transaction delimiters.');
  }
  return sql.replace(/^begin;\s*/i, '').replace(/\scommit;\s*$/i, '');
}

async function verify() {
  assertProjectIdentity();
  if (process.env.DOCKER_HOST && !/^(unix:\/\/|npipe:\/\/)/.test(process.env.DOCKER_HOST)) {
    throw new Error('Remote DOCKER_HOST is not allowed by this local verification.');
  }
  const context = await run('docker', ['context', 'inspect']);
  const host: unknown = context.ok ? JSON.parse(context.output)[0]?.Endpoints?.docker?.Host : null;
  if (typeof host !== 'string' || !/^(unix:\/\/|npipe:\/\/)/.test(host)) {
    throw new Error('Local Docker is unavailable.');
  }
  const [rollback, migration] = await Promise.all([
    migrationBody('supabase/rollbacks/20260917010000_route_composition_revision.rollback.sql'),
    migrationBody('supabase/migrations/20260917010000_route_composition_revision.sql'),
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
      if to_regprocedure('api.change_route_composition(uuid,jsonb,uuid,text)') is not null
        or to_regclass('private.audit_events_route_composition_idempotency_key') is not null
        or has_table_privilege('cirne_route_executor', 'private.audit_events', 'SELECT') then
        raise exception 'Rollback did not remove the composition capability';
      end if;
      if not exists (select 1 from information_schema.columns
          where table_schema = 'api' and table_name = 'route_versions' and column_name = 'change_reason') then
        raise exception 'Rollback removed preserved version metadata';
      end if;
      if (${snapshot}) is distinct from (select document from rollback_snapshot) then
        raise exception 'Rollback changed stored route, execution or audit data';
      end if;
    end $verify_rollback$;
    ${migration}
    do $verify_reapply$ begin
      if to_regprocedure('api.change_route_composition(uuid,jsonb,uuid,text)') is null
        or to_regclass('private.audit_events_route_composition_idempotency_key') is null
        or not has_table_privilege('cirne_route_executor', 'private.audit_events', 'SELECT') then
        raise exception 'Reapplication did not restore the composition capability';
      end if;
      if (${snapshot}) is distinct from (select document from rollback_snapshot) then
        raise exception 'Reapplication changed stored route, execution or audit data';
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
      else reject(new Error(`Route composition rollback verification failed: ${errors}`));
    });
    child.stdin.end(sql);
  });
  console.log('Route composition rollback and reapplication preserved versions, executions and audit data.');
}

verify().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Route composition rollback verification failed.');
  process.exitCode = 1;
});
