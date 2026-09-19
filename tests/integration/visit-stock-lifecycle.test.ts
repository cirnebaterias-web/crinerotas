import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

const container = 'supabase_db_cirne-rotas-dev';
const useRancherDesktopWsl = process.platform === 'win32' &&
  process.env.CIRNE_DOCKER_BACKEND === 'rancher-desktop-wsl';
const dockerProgram = useRancherDesktopWsl ? 'wsl' : 'docker';
const dockerPrefix = useRancherDesktopWsl ? ['-d', 'rancher-desktop', '--', 'docker'] : [];

function docker(args: string[], input?: string) {
  return new Promise<string>((resolve, reject) => {
    const child = execFile(dockerProgram, [...dockerPrefix, ...args], {
      windowsHide: true, timeout: 25_000, maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(`Isolated stock lifecycle check failed: ${stderr}`, { cause: error }));
      else resolve(stdout);
    });
    child.stdin?.end(input);
  });
}

function sql(database: string, input: string, user = 'postgres') {
  return docker(['exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
    '-U', user, '-d', database], input);
}

it('rolls stock back without history, reapplies it as non-superuser, and installs owner-scoped ACLs', async () => {
  // Clone schema only into a uniquely named test database. Never roll back the working database.
  const database = `cirne_stock_lifecycle_${crypto.randomUUID().replaceAll('-', '')}`;
  if (!/^cirne_stock_lifecycle_[0-9a-f]{32}$/.test(database)) throw new Error('Invalid test database name');
  const snapshot = await docker(['exec', container, 'pg_dump', '-U', 'supabase_admin', '-d', 'postgres',
    '--schema-only', '--schema=auth', '--schema=api', '--schema=private', '--no-publications', '--no-subscriptions']);
  expect(snapshot).toContain('CREATE TABLE api.stock_snapshots');
  await sql('postgres', `create database ${database} owner postgres;`, 'supabase_admin');
  try {
    await sql(database, `create schema extensions;
      create extension postgis with schema extensions;
      create extension pgcrypto with schema extensions;
      create extension "uuid-ossp" with schema extensions;`, 'supabase_admin');
    await sql(database, snapshot, 'supabase_admin');
    expect((await sql(database, 'select count(*) from api.stock_snapshots;')).trim()).toBe('0');
    expect((await sql(database, "select rolsuper from pg_roles where rolname = current_user;")).trim()).toBe('f');
    const rollback = await readFile('supabase/rollbacks/20260917223000_visit_stock.rollback.sql', 'utf8');
    await sql(database, rollback);
    expect((await sql(database, "select to_regclass('api.stock_snapshots') is null;")).trim()).toBe('t');
    const migration = await readFile('supabase/migrations/20260917223000_visit_stock.sql', 'utf8');
    await sql(database, migration);
    expect((await sql(database, `select
      not has_function_privilege('anon', 'private.get_visit_stock_result(uuid)', 'EXECUTE')
      and not has_function_privilege('authenticated', 'private.apply_visit_stock_saved(uuid,jsonb)', 'EXECUTE')
      and not has_function_privilege('anon', 'private.save_visit_stock(uuid,uuid,jsonb)', 'EXECUTE')
      and not has_function_privilege('anon', 'api.save_visit_stock(uuid,uuid,jsonb)', 'EXECUTE')
      and has_function_privilege('authenticated', 'api.save_visit_stock(uuid,uuid,jsonb)', 'EXECUTE')
      and has_function_privilege('cirne_sync_executor', 'private.get_visit_stock_result(uuid)', 'EXECUTE')
      and has_function_privilege('cirne_sync_executor', 'private.apply_visit_stock_saved(uuid,jsonb)', 'EXECUTE')
      and has_function_privilege('cirne_visit_executor', 'private.save_visit_stock(uuid,uuid,jsonb)', 'EXECUTE')
      and has_function_privilege('cirne_visit_executor', 'private.sync_event(uuid,jsonb)', 'EXECUTE')
      and not has_schema_privilege('cirne_sync_executor', 'private', 'CREATE');`)).trim()).toBe('t');
  } finally {
    // Exact generated database only; it contains no user data and all connections are closed.
    await sql('postgres', `drop database ${database};`, 'supabase_admin');
  }
}, 120_000);
