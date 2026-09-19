import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';

const dockerProgram = process.platform === 'win32' ? 'wsl' : 'docker';
const dockerPrefix = process.platform === 'win32'
  ? ['-d', 'rancher-desktop', '--', 'docker']
  : [];

// Deliberately local-only: no database URL, password, remote host or new driver dependency.
function runSql(command: string) {
  return new Promise<{ ok: boolean; output: string }>((resolve) => {
    const commandArgument = process.platform === 'win32' ? command.replace(/\$/g, '\\$') : command;
    execFile(dockerProgram, [...dockerPrefix, 'exec', 'supabase_db_cirne-rotas-dev', 'psql', '-X', '-qAt',
      '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres', '-c', commandArgument],
    { windowsHide: true, timeout: 25_000, maxBuffer: 512 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, output: stdout + stderr });
    });
  });
}

async function sql(command: string) {
  let result = await runSql(command);
  for (let attempt = 1; attempt < 3 && !result.ok &&
    /failed to connect to the backend|timed out dialing Hyper-V socket|open \\.\\pipe\\docker_engine/i.test(result.output);
    attempt += 1) {
    await delay(attempt * 250);
    result = await runSql(command);
  }
  return result;
}

async function jsonSql<T>(command: string): Promise<T> {
  const result = await sql(command);
  if (!result.ok) throw new Error('Local concurrency fixture/query failed.');
  const json = result.output.split(/\r?\n/).find((line) => line.startsWith('{'));
  if (!json) throw new Error('Missing local query result.');
  return JSON.parse(json) as T;
}

function uuid(value: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error('Invalid synthetic fixture UUID.');
  }
  return value;
}

it('serializes overlapping visit starts, rejects divergent content, and persists each effect once', async () => {
  const actors = await jsonSql<{ seller: string; manager: string }>(`select jsonb_build_object(
    'seller', (select id from auth.users where raw_user_meta_data ->> 'actorKey' = 'seller_a'),
    'manager', (select id from auth.users where raw_user_meta_data ->> 'actorKey' = 'manager_a'))`);
  const seller = uuid(actors.seller);
  const manager = uuid(actors.manager);
  // A dedicated future route avoids consuming the daily route used by API/CLI/browser tests.
  // Keep these exclusively synthetic facts for inspection; never reset shared fixtures.
  const route = await jsonSql<{ routeId: string; routeVersionId: string }>(`begin;
    select pg_advisory_xact_lock(31003100);
    select set_config('request.jwt.claim.sub', '${manager}', true);
    select set_config('test.visit_date', (select (greatest(coalesce(max(service_date), date '2199-12-31'), date '2199-12-31') + 1)::text
      from api.routes where seller_id = '${seller}' and service_date < date '2300-01-01'), true);
    set local role authenticated;
    select api.create_route_draft(jsonb_build_object('schemaVersion', 1,
      'serviceDate', current_setting('test.visit_date'), 'sellerId', '${seller}',
      'stops', jsonb_build_array(
        jsonb_build_object('clientId', '10000000-0000-4000-8000-000000000001', 'plannedOrder', 1, 'priority', 0),
        jsonb_build_object('clientId', '10000000-0000-4000-8000-000000000002', 'plannedOrder', 2, 'priority', 0))));
    commit;`);
  const routeId = uuid(route.routeId);
  const routeVersionId = uuid(route.routeVersionId);
  const publication = await sql(`begin; select set_config('request.jwt.claim.sub', '${manager}', true);
    set local role authenticated; select api.publish_route('${routeId}', 1); commit;`);
  expect(publication.ok).toBe(true);
  const stops = await jsonSql<{ first: string; second: string }>(`select jsonb_build_object(
    'first', (select id from api.route_version_stops where route_version_id = '${routeVersionId}' and planned_order = 1),
    'second', (select id from api.route_version_stops where route_version_id = '${routeVersionId}' and planned_order = 2))`);

  for (const divergent of [false, true]) {
    const stop = uuid(divergent ? stops.second : stops.first);
    const device = crypto.randomUUID();
    const offlineId = crypto.randomUUID();
    const key = crypto.randomUUID();
    const appName = `visit-test-${device}`;
    const gateAppName = `visit-gate-${device}`;
    const startGate = divergent ? 31003102 : 31003101;
    const command = (second: boolean) => `begin;
      set local application_name = '${appName}';
      select set_config('request.jwt.claim.sub', '${seller}', true);
      set local role authenticated;
      select pg_advisory_xact_lock_shared(${startGate});
      select api.start_visit('${device}', '${key}', jsonb_build_object('schemaVersion', 1,
        'offlineId', '${offlineId}', 'routeVersionStopId', '${stop}',
        'deviceStartedAt', '${divergent && second ? '2200-01-01T12:00:01.000Z' : '2200-01-01T12:00:00.000Z'}',
        'location', jsonb_build_object('latitude', '-7.115', 'longitude', '-34.864', 'accuracyM', '12.5')));
      select pg_sleep(3); commit;`;

    // Hold an exclusive test gate until both sessions are queued. Once released, both sessions
    // acquire a compatible shared lock and enter start_visit together; only the product lock can
    // serialize them from that point onward.
    const gateHolder = sql(`set application_name = '${gateAppName}';
      select pg_advisory_lock(${startGate}); select pg_sleep(3); select pg_advisory_unlock(${startGate});`);
    let gateAcquired = false;
    const gateDeadline = Date.now() + 10_000;
    while (!gateAcquired && Date.now() < gateDeadline) {
      const state = await sql(`select count(*) from pg_locks held
        join pg_stat_activity activity on activity.pid = held.pid
        where activity.application_name = '${gateAppName}'
          and held.locktype = 'advisory' and held.granted`);
      gateAcquired = state.ok && Number(state.output.trim()) > 0;
      if (!gateAcquired) await delay(50);
    }
    expect(gateAcquired, 'The concurrency start gate must be acquired before launching contenders').toBe(true);

    const first = sql(command(false));
    const second = sql(command(true));
    await gateHolder;
    let observedLockWait = false;
    const deadline = Date.now() + 8_000;
    while (!observedLockWait && Date.now() < deadline) {
      const state = await sql(`select count(*) from pg_stat_activity
        where application_name = '${appName}' and wait_event_type = 'Lock'`);
      observedLockWait = state.ok && Number(state.output.trim()) > 0;
      if (!observedLockWait) await delay(50);
    }
    const outcomes = await Promise.all([first, second]);
    expect(observedLockWait, 'Actual overlapping transactions must be observed, not just sequential replay').toBe(true);
    expect(outcomes.filter((result) => result.ok)).toHaveLength(divergent ? 1 : 2);
    if (divergent) {
      expect(outcomes.find((result) => !result.ok)?.output).toContain('IDEMPOTENCY_KEY_REUSED');
    } else {
      const canonical = outcomes.map((result) => JSON.parse(result.output.split(/\r?\n/).find((line) => line.startsWith('{'))!));
      expect(canonical[0]).toEqual(canonical[1]);
    }
    const effects = await jsonSql<Record<string, number | string>>(`select jsonb_build_object(
      'visits', (select count(*) from api.visits where seller_id = '${seller}' and device_id = '${device}' and offline_id = '${offlineId}'),
      'locations', (select count(*) from api.location_events where visit_id in (select id from api.visits where device_id = '${device}')),
      'audit', (select count(*) from private.audit_events where action = 'visit.started.v1' and target_id in (select id from api.visits where device_id = '${device}')),
      'confirmations', (select count(*) from private.sync_events where actor_id = '${seller}' and device_id = '${device}' and idempotency_key = '${key}'),
      'status', (select status from api.route_stop_executions where route_version_stop_id = '${stop}'),
      'executionVersion', (select lock_version from api.route_stop_executions where route_version_stop_id = '${stop}'))`);
    expect(effects).toEqual({ visits: 1, locations: 1, audit: 1, confirmations: 1, status: 'in_visit', executionVersion: 2 });
  }

  // Execute only the inspected preflight in a transaction, never the destructive rollback body.
  const rollback = await readFile('supabase/rollbacks/20260917140000_visit_start.rollback.sql', 'utf8');
  const preflight = rollback.match(/do \$preflight\$[\s\S]*?\$preflight\$;/)?.[0];
  expect(preflight).toBeDefined();
  const before = await sql(`select count(*) from api.visits`);
  expect(before.ok).toBe(true);
  expect(Number(before.output.trim())).toBeGreaterThanOrEqual(2);
  const refused = await sql(`begin; set local lock_timeout = '2s'; ${preflight} rollback;`);
  expect(refused.ok).toBe(false);
  expect(refused.output).toContain('VISIT_ROLLBACK_REQUIRES_COORDINATED_RECOVERY');
  const after = await sql(`select count(*) from api.visits`);
  expect(after).toEqual(before);
}, 90_000);
