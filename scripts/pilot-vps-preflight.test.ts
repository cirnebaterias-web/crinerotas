import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { pilotVpsPreflight, pilotVpsPreflightExitCodes } from './pilot-vps-preflight';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const resolvedCompose = JSON.stringify({
  services: {
    app: {
      image: `ghcr.io/cirnebaterias-web/cirne-rotas@sha256:${'a'.repeat(64)}`,
      read_only: true,
      networks: { app_internal: null, egress: null },
    },
    caddy: {
      read_only: true,
      networks: { edge: null, app_internal: null },
      ports: [
        { published: '80', target: 80 },
        { published: '443', target: 443 },
        { published: '443', target: 443 },
      ],
      volumes: [
        { source: 'Caddyfile', target: '/etc/caddy/Caddyfile' },
        { source: 'data', target: '/data' },
        { source: 'config', target: '/config' },
      ],
    },
  },
  networks: { edge: {}, egress: {}, app_internal: { internal: true } },
});

async function fixture(overrides: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'cirne-preflight-'));
  temporaryDirectories.push(root);
  await Promise.all([
    mkdir(path.join(root, 'infrastructure/compose'), { recursive: true }),
    mkdir(path.join(root, 'infrastructure/caddy'), { recursive: true }),
    mkdir(path.join(root, 'infrastructure/docker'), { recursive: true }),
    mkdir(path.join(root, 'private'), { recursive: true }),
  ]);
  const envFilePath = path.join(root, 'private/pilot.env');
  const values: Record<string, string> = {
    CIRNE_APP_IMAGE: `ghcr.io/cirnebaterias-web/cirne-rotas@sha256:${'a'.repeat(64)}`,
    CIRNE_RELEASE_SHA: 'b'.repeat(40),
    CIRNE_ENV_FILE: envFilePath,
    APP_DOMAIN: 'rotas.example.com',
    APP_BASE_URL: 'https://rotas.example.com',
    ACME_EMAIL: 'ops@example.com',
    OPERATIONAL_TIME_ZONE: 'America/Sao_Paulo',
    NODE_ENV: 'production',
    LOG_LEVEL: 'info',
    SUPABASE_PUBLIC_URL: 'https://project.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_synthetic_value',
    CONTABO_VPS_READY: 'confirmed', DNS_READY: 'confirmed', SMTP_READY: 'confirmed',
    SECRETS_READY: 'confirmed', BACKUP_EXTERNAL_READY: 'confirmed',
    MONITOR_EXTERNAL_READY: 'confirmed', ROLLBACK_DRILL_READY: 'confirmed',
    ...overrides,
  };
  await Promise.all([
    writeFile(envFilePath, Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n')),
    writeFile(path.join(root, 'infrastructure/compose/compose.pilot.yaml'), [
      'services:', '  app:', '    image: "${CIRNE_APP_IMAGE:?required}"',
      '    env_file: ["${CIRNE_ENV_FILE:?required}"]', '    networks: [app_internal, egress]',
      '  caddy:', '    image: caddy:2.11.4-alpine', 'networks:', '  egress:', '  app_internal:', '    internal: true',
    ].join('\n')),
    writeFile(path.join(root, 'infrastructure/caddy/Caddyfile'), [
      '{', '  admin off', '}', 'domain {', '  reverse_proxy app:3000', '  log {',
      '    format filter {', '      wrap json', '      fields {', '        request delete',
      '        resp_headers delete', '      }', '    }', '  }',
      '  log_append request_path {http.request.uri.path}', '}',
    ].join('\n')),
    writeFile(path.join(root, 'infrastructure/docker/Dockerfile'), 'FROM scratch\nUSER node\n'),
  ]);
  await chmod(envFilePath, 0o600);
  return { root, envFilePath };
}

const composeRunner = async (command: string, args: readonly string[]) => {
  if (command === 'git') return { ok: true, output: 'b'.repeat(40) };
  if (args[0] === 'image') return { ok: true, output: 'b'.repeat(40) };
  return { ok: true, output: resolvedCompose };
};

it('approves immutable isolated artifacts without requiring external deploy evidence', async () => {
  const setup = await fixture({ CONTABO_VPS_READY: 'pending' });
  const result = await pilotVpsPreflight({ ...setup, scope: 'artifact', platform: 'win32' }, composeRunner);
  expect(result.status, JSON.stringify(result.checks.filter((item) => item.status !== 'pass'))).toBe('ready');
  expect(result.checks).not.toContainEqual(expect.objectContaining({ status: 'blocked' }));
  expect(JSON.stringify(result)).not.toContain('sb_publishable_synthetic_value');
});

it('blocks deployment when any external evidence is pending', async () => {
  const setup = await fixture({ MONITOR_EXTERNAL_READY: 'pending', SMTP_READY: 'pending' });
  const result = await pilotVpsPreflight({ ...setup, scope: 'deploy', platform: 'win32' }, composeRunner);
  expect(result.status, JSON.stringify(result.checks.filter((item) => item.status !== 'pass'))).toBe('blocked');
  expect(result.checks.filter((item) => item.status === 'blocked').map((item) => item.id))
    .toEqual(expect.arrayContaining(['external.monitor_external_ready', 'external.smtp_ready']));
  expect(pilotVpsPreflightExitCodes[result.status]).toBe(2);
});

it.each([
  ['mutable image', { CIRNE_APP_IMAGE: 'ghcr.io/example/app:latest' }, 'env.image-digest'],
  ['wrong application origin', { APP_BASE_URL: 'https://other.example.com' }, 'env.app-base-url'],
  ['privileged Supabase placeholder', { SUPABASE_PUBLISHABLE_KEY: 'replace-with-service-role-secret' }, 'env.supabase-publishable-key'],
])('rejects %s without exposing the configured value', async (_name, overrides, failedId) => {
  const setup = await fixture(overrides);
  const result = await pilotVpsPreflight({ ...setup, scope: 'artifact', platform: 'linux' }, composeRunner);
  expect(result.status).toBe('invalid');
  expect(result.checks).toContainEqual(expect.objectContaining({ id: failedId, status: 'fail' }));
  for (const value of Object.values(overrides)) expect(JSON.stringify(result)).not.toContain(value);
});

it('rejects public environment permissions on Linux but defers that check on Windows', async () => {
  const setup = await fixture();
  await chmod(setup.envFilePath, 0o644);
  const linux = await pilotVpsPreflight({ ...setup, scope: 'artifact', platform: 'linux' }, composeRunner);
  const windows = await pilotVpsPreflight({ ...setup, scope: 'artifact', platform: 'win32' }, composeRunner);
  expect(linux.checks).toContainEqual(expect.objectContaining({ id: 'env.permissions', status: 'fail' }));
  expect(windows.checks).toContainEqual(expect.objectContaining({ id: 'env.permissions', status: 'pass' }));
});

it('fails closed when Docker Compose cannot resolve the manifest', async () => {
  const setup = await fixture();
  const result = await pilotVpsPreflight({ ...setup, scope: 'artifact', platform: 'linux' },
    async () => ({ ok: false, output: 'token-that-must-not-leak' }));
  expect(result.status).toBe('invalid');
  expect(JSON.stringify(result)).not.toContain('token-that-must-not-leak');
  expect(result.checks).toContainEqual(expect.objectContaining({ id: 'dependency.compose', status: 'fail' }));
});

it('rejects a resolved app image or revision that differs from the approved release', async () => {
  const setup = await fixture();
  const result = await pilotVpsPreflight({ ...setup, scope: 'artifact', platform: 'linux' },
    async (command, args) => {
      if (command === 'git') return { ok: true, output: 'b'.repeat(40) };
      if (args[0] === 'image') return { ok: true, output: 'c'.repeat(40) };
      const config = JSON.parse(resolvedCompose);
      config.services.app.image = `ghcr.io/cirnebaterias-web/cirne-rotas@sha256:${'d'.repeat(64)}`;
      return { ok: true, output: JSON.stringify(config) };
    });
  expect(result.status).toBe('invalid');
  expect(result.checks).toContainEqual(expect.objectContaining({ id: 'compose.image', status: 'fail' }));
  expect(result.checks).toContainEqual(expect.objectContaining({ id: 'dependency.image-revision', status: 'fail' }));
});
