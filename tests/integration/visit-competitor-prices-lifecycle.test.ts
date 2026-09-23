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
      if (error) reject(new Error(`Isolated competitor-prices lifecycle check failed: ${stderr}`, { cause: error }));
      else resolve(stdout);
    });
    child.stdin?.end(input);
  });
}

function sql(database: string, input: string, user = 'postgres') {
  return docker(['exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
    '-U', user, '-d', database], input);
}

it('rolls competitor prices back only without history, reapplies them and preserves narrow ACLs', async () => {
  const database = `cirne_prices_lifecycle_${crypto.randomUUID().replaceAll('-', '')}`;
  if (!/^cirne_prices_lifecycle_[0-9a-f]{32}$/.test(database)) throw new Error('Invalid test database name');
  const snapshot = await docker(['exec', container, 'pg_dump', '-U', 'supabase_admin', '-d', 'postgres',
    '--schema-only', '--schema=auth', '--schema=api', '--schema=private', '--no-publications', '--no-subscriptions']);
  expect(snapshot).toContain('CREATE TABLE api.competitor_price_reports');
  await sql('postgres', `create database ${database} owner postgres;`, 'supabase_admin');
  try {
    await sql(database, `create schema extensions;
      create extension postgis with schema extensions;
      create extension pgcrypto with schema extensions;
      create extension "uuid-ossp" with schema extensions;`, 'supabase_admin');
    await sql(database, snapshot, 'supabase_admin');
    const rollback = await readFile('supabase/rollbacks/20260921103000_visit_competitor_prices.rollback.sql', 'utf8');
    await sql(database, rollback);
    expect((await sql(database, "select to_regclass('api.competitor_price_reports') is null;")).trim()).toBe('t');

    const migration = await readFile('supabase/migrations/20260921103000_visit_competitor_prices.sql', 'utf8');
    await sql(database, migration);
    expect((await sql(database, `select
      has_function_privilege('authenticated', 'api.save_visit_competitor_prices(uuid,uuid,jsonb)', 'EXECUTE')
      and has_function_privilege('authenticated', 'api.get_current_competitor_price_parameters(timestamptz)', 'EXECUTE')
      and not has_function_privilege('anon', 'api.save_visit_competitor_prices(uuid,uuid,jsonb)', 'EXECUTE')
      and not has_table_privilege('authenticated', 'api.parameter_values', 'SELECT')
      and not has_function_privilege('authenticated', 'private.apply_visit_competitor_prices_saved(uuid,jsonb)', 'EXECUTE')
      and has_function_privilege('cirne_sync_executor', 'private.apply_visit_competitor_prices_saved(uuid,jsonb)', 'EXECUTE')
      and has_function_privilege('cirne_visit_executor', 'private.save_visit_competitor_prices(uuid,uuid,jsonb)', 'EXECUTE')
      and not has_schema_privilege('cirne_visit_executor', 'api', 'CREATE')
      and not has_schema_privilege('cirne_sync_executor', 'private', 'CREATE');`)).trim()).toBe('t');

    await sql(database, `grant cirne_visit_executor to postgres with set true granted by current_user;
      set role cirne_visit_executor;
      insert into api.parameter_sets (id, version, status, valid_from)
      values ('90000000-0000-4000-8000-000000000333', 333, 'draft', '2100-01-01T00:00:00Z');
      insert into api.parameter_values (id, parameter_set_id, category, code, label)
      values ('31000000-0000-4000-8000-000000000333', '90000000-0000-4000-8000-000000000333',
        'competitor', 'synthetic_rollback_guard', 'Concorrente Sintetico');
      reset role;
      revoke cirne_visit_executor from postgres granted by current_user;`);
    await expect(sql(database, rollback)).rejects.toThrow('Rollback refused: competitor-price history or parameter values exist');
    expect((await sql(database, 'select count(*) from api.parameter_values;')).trim()).toBe('1');
  } finally {
    await sql('postgres', `drop database ${database};`, 'supabase_admin');
  }
}, 120_000);
