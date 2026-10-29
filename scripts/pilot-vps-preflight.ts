import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { run, type Run } from './process';

export type PilotVpsPreflightScope = 'artifact' | 'deploy';
export type PilotVpsPreflightCheck = {
  id: string;
  status: 'pass' | 'fail' | 'blocked';
  detail: string;
};
export type PilotVpsPreflightResult = {
  schemaVersion: 1;
  status: 'ready' | 'invalid' | 'blocked';
  scope: PilotVpsPreflightScope;
  checks: PilotVpsPreflightCheck[];
};
export type PilotVpsPreflightOptions = {
  root?: string;
  composePath?: string;
  caddyfilePath?: string;
  dockerfilePath?: string;
  envFilePath: string;
  scope: PilotVpsPreflightScope;
  platform?: NodeJS.Platform;
};

const externalEvidence = [
  'CONTABO_VPS_READY',
  'DNS_READY',
  'SMTP_READY',
  'SECRETS_READY',
  'BACKUP_EXTERNAL_READY',
  'MONITOR_EXTERNAL_READY',
  'ROLLBACK_DRILL_READY',
] as const;

function check(id: string, ok: boolean, pass: string, failure: string): PilotVpsPreflightCheck {
  return { id, status: ok ? 'pass' : 'fail', detail: ok ? pass : failure };
}

function safePath(root: string, candidate: string, label: string) {
  const resolved = path.resolve(root, candidate);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} deve permanecer dentro do diretório do projeto.`);
  }
  return resolved;
}

function parseEnvironment(source: string) {
  const values = new Map<string, string>();
  for (const [index, rawLine] of source.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) throw new Error(`Linha ${index + 1} do ambiente possui formato inválido.`);
    const key = match[1]!;
    if (values.has(key)) throw new Error(`Variável duplicada: ${key}.`);
    let value = match[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values.set(key, value);
  }
  return values;
}

function validOrigin(value: string | undefined, protocol = 'https:') {
  try {
    const url = new URL(value ?? '');
    return url.protocol === protocol && !url.username && !url.password &&
      url.pathname === '/' && !url.search && !url.hash;
  } catch { return false; }
}

function validTimeZone(value: string | undefined) {
  if (!value) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date(0));
    return true;
  } catch { return false; }
}

function environmentChecks(values: Map<string, string>, envFilePath: string, composeDirectory: string) {
  const appDomain = values.get('APP_DOMAIN');
  const appBaseUrl = values.get('APP_BASE_URL');
  const supabaseUrl = values.get('SUPABASE_PUBLIC_URL');
  const image = values.get('CIRNE_APP_IMAGE');
  const releaseSha = values.get('CIRNE_RELEASE_SHA');
  const configuredEnvFile = values.get('CIRNE_ENV_FILE');
  const expectedEnvFile = path.resolve(envFilePath);
  const resolvedConfiguredEnvFile = configuredEnvFile
    ? path.resolve(composeDirectory, configuredEnvFile)
    : '';
  const domainOk = !!appDomain && /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(appDomain);
  let appHost = '';
  try { appHost = new URL(appBaseUrl ?? '').hostname; } catch { /* reported below */ }
  let supabaseHost = '';
  try { supabaseHost = new URL(supabaseUrl ?? '').hostname; } catch { /* reported below */ }
  const publishableKey = values.get('SUPABASE_PUBLISHABLE_KEY');

  return [
    check('env.app-domain', domainOk, 'Domínio do aplicativo válido.', 'APP_DOMAIN ausente ou inválido.'),
    check('env.app-base-url', validOrigin(appBaseUrl) && appHost === appDomain,
      'APP_BASE_URL usa HTTPS e corresponde ao domínio.', 'APP_BASE_URL deve ser uma origem HTTPS do APP_DOMAIN.'),
    check('env.acme-email', /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.get('ACME_EMAIL') ?? ''),
      'Contato ACME informado.', 'ACME_EMAIL ausente ou inválido.'),
    check('env.supabase-url', validOrigin(supabaseUrl) && supabaseHost !== appHost,
      'Supabase Cloud usa origem HTTPS separada.', 'SUPABASE_PUBLIC_URL deve ser uma origem HTTPS separada da aplicação.'),
    check('env.supabase-publishable-key', !!publishableKey && publishableKey.length >= 20 &&
      !/replace|example|secret|service.role/i.test(publishableKey),
      'Chave publicável do Supabase informada.', 'SUPABASE_PUBLISHABLE_KEY está ausente ou contém placeholder/credencial inadequada.'),
    check('env.runtime', values.get('NODE_ENV') === 'production' &&
      ['fatal', 'error', 'warn', 'info'].includes(values.get('LOG_LEVEL') ?? '') &&
      validTimeZone(values.get('OPERATIONAL_TIME_ZONE')),
    'Runtime de produção, log e fuso válidos.', 'NODE_ENV, LOG_LEVEL ou OPERATIONAL_TIME_ZONE inválido.'),
    check('env.image-digest', /^ghcr\.io\/[a-z0-9._-]+\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/i.test(image ?? '') &&
      !/@sha256:0{64}$/i.test(image ?? ''),
    'Imagem GHCR está fixada por digest.', 'CIRNE_APP_IMAGE deve usar GHCR e digest SHA-256 imutável, sem placeholder.'),
    check('env.release-sha', /^[a-f0-9]{40}$/i.test(releaseSha ?? '') && !/^0{40}$/i.test(releaseSha ?? ''),
      'Commit aprovado da release informado.', 'CIRNE_RELEASE_SHA deve conter o SHA completo e nao nulo do commit aprovado.'),
    check('env.file-reference', resolvedConfiguredEnvFile === expectedEnvFile,
      'CIRNE_ENV_FILE referencia o arquivo validado.', 'CIRNE_ENV_FILE deve apontar para o mesmo arquivo fornecido ao preflight.'),
  ];
}

function staticArtifactChecks(compose: string, caddyfile: string, dockerfile: string) {
  const forbidden = /\bn8n\b|docker\.sock|:latest\b/i;
  return [
    check('artifact.forbidden-references', !forbidden.test(`${compose}\n${caddyfile}`),
      'Nenhuma referência proibida a infraestrutura compartilhada, socket ou tag móvel.',
      'Compose/Caddy contém referência a n8n, Docker socket ou tag latest.'),
    check('artifact.compose-contract', compose.includes('${CIRNE_APP_IMAGE:') &&
      compose.includes('${CIRNE_ENV_FILE:') && compose.includes('app_internal:') && compose.includes('egress:') &&
      compose.includes('internal: true'),
    'Compose exige imagem/ambiente e rede interna.', 'Compose não preserva imagem/ambiente obrigatórios e rede interna.'),
    check('artifact.caddy-contract', caddyfile.includes('admin off') &&
      caddyfile.includes('reverse_proxy app:3000') && caddyfile.includes('wrap json') &&
      caddyfile.includes('log_append request_path {http.request.uri.path}') &&
      caddyfile.includes('request delete') && caddyfile.includes('resp_headers delete'),
    'Caddy desativa administração pública, usa upstream interno e redige logs.',
    'Caddyfile não contém os controles obrigatórios de administração, upstream e redaction.'),
    check('artifact.non-root-image', /^USER node$/m.test(dockerfile) && !/docker\.sock/i.test(dockerfile),
      'Imagem da aplicação executa como usuário não-root e sem socket Docker.',
      'Dockerfile não comprova runtime não-root ou referencia o socket Docker.'),
  ];
}

function resolvedComposeChecks(output: string, expectedImage: string | undefined): PilotVpsPreflightCheck[] {
  try {
    const config = JSON.parse(output) as {
      services?: Record<string, {
        image?: string;
        ports?: Array<{ published?: string | number; target?: string | number }>;
        networks?: Record<string, unknown>;
        read_only?: boolean;
        volumes?: Array<{ target?: string; source?: string }>;
      }>;
      networks?: Record<string, { internal?: boolean }>;
    };
    const app = config.services?.app;
    const caddy = config.services?.caddy;
    const published = caddy?.ports ?? [];
    const onlyWebPorts = published.length >= 2 && published.every((port) =>
      ['80', '443'].includes(String(port.published)) && ['80', '443'].includes(String(port.target)));
    const appNetworks = Object.keys(app?.networks ?? {});
    const caddyNetworks = Object.keys(caddy?.networks ?? {});
    const caddyTargets = (caddy?.volumes ?? []).map((volume) => volume.target);
    return [
      check('compose.services', !!app && !!caddy && Object.keys(config.services ?? {}).length === 2,
        'Compose resolve exatamente aplicação e Caddy.', 'Compose deve resolver exatamente os serviços app e caddy.'),
      check('compose.image', !!expectedImage && app?.image === expectedImage,
        'Compose resolveu exatamente o digest aprovado.', 'A imagem resolvida para app diverge do CIRNE_APP_IMAGE validado.'),
      check('compose.ports', !app?.ports?.length && onlyWebPorts,
        'Somente Caddy publica 80/443; aplicação não possui porta pública.',
        'A aplicação publicou porta ou Caddy publicou porta diferente de 80/443.'),
      check('compose.networks', appNetworks.length === 2 && appNetworks.includes('app_internal') && appNetworks.includes('egress') &&
        caddyNetworks.includes('edge') && caddyNetworks.includes('app_internal') &&
        config.networks?.app_internal?.internal === true && config.networks?.egress?.internal !== true,
      'Aplicação está isolada e Caddy conecta borda à rede interna.', 'Topologia de redes do piloto está inválida.'),
      check('compose.filesystems', app?.read_only === true && caddy?.read_only === true &&
        caddyTargets.includes('/etc/caddy/Caddyfile') && caddyTargets.includes('/data') && caddyTargets.includes('/config'),
      'Filesystems são somente leitura e certificados/configuração usam volumes próprios.',
      'Read-only ou volumes próprios do Caddy não foram resolvidos corretamente.'),
    ];
  } catch {
    return [{ id: 'compose.parse', status: 'fail', detail: 'Docker Compose não retornou configuração JSON válida.' }];
  }
}

export async function pilotVpsPreflight(
  options: PilotVpsPreflightOptions,
  execute: Run = run,
): Promise<PilotVpsPreflightResult> {
  const root = path.resolve(options.root ?? process.cwd());
  const composePath = safePath(root, options.composePath ?? 'infrastructure/compose/compose.pilot.yaml', 'Compose');
  const caddyfilePath = safePath(root, options.caddyfilePath ?? 'infrastructure/caddy/Caddyfile', 'Caddyfile');
  const dockerfilePath = safePath(root, options.dockerfilePath ?? 'infrastructure/docker/Dockerfile', 'Dockerfile');
  const envFilePath = path.resolve(root, options.envFilePath);
  const checks: PilotVpsPreflightCheck[] = [];

  const envStat = await lstat(envFilePath);
  if (!envStat.isFile() || envStat.isSymbolicLink()) throw new Error('O arquivo de ambiente deve ser regular e não pode ser link simbólico.');
  const mode = envStat.mode & 0o777;
  const permissionOk = options.platform === 'win32' || (mode & 0o077) === 0;
  checks.push(check('env.permissions', permissionOk,
    options.platform === 'win32' ? 'Permissões serão verificadas no host Linux.' : 'Arquivo de ambiente restrito ao proprietário.',
    'No Linux, restrinja o arquivo de ambiente para remover acesso de grupo/outros (por exemplo, chmod 600).'));

  const [envSource, composeSource, caddyfileSource, dockerfileSource] = await Promise.all([
    readFile(envFilePath, 'utf8'), readFile(composePath, 'utf8'),
    readFile(caddyfilePath, 'utf8'), readFile(dockerfilePath, 'utf8'),
  ]);
  const values = parseEnvironment(envSource);
  checks.push(...environmentChecks(values, envFilePath, path.dirname(composePath)));
  checks.push(...staticArtifactChecks(composeSource, caddyfileSource, dockerfileSource));

  const composeResult = await execute('docker', [
    'compose', '--env-file', envFilePath, '-f', composePath, 'config', '--format', 'json',
  ], 30000);
  checks.push(check('dependency.compose', composeResult.ok,
    'Docker Compose resolveu o manifesto.', 'Docker Compose indisponível ou manifesto inválido.'));
  const image = values.get('CIRNE_APP_IMAGE');
  const releaseSha = values.get('CIRNE_RELEASE_SHA');
  if (composeResult.ok) checks.push(...resolvedComposeChecks(composeResult.output, image));

  const [gitResult, imageRevisionResult] = await Promise.all([
    execute('git', ['rev-parse', 'HEAD'], 10000),
    execute('docker', ['image', 'inspect', '--format',
      '{{ index .Config.Labels "org.opencontainers.image.revision" }}', image ?? 'invalid-image'], 30000),
  ]);
  checks.push(check('dependency.git-commit', gitResult.ok && gitResult.output.trim() === releaseSha,
    'Checkout corresponde ao commit aprovado.', 'Checkout atual nao corresponde ao CIRNE_RELEASE_SHA aprovado.'));
  checks.push(check('dependency.image-revision', imageRevisionResult.ok && imageRevisionResult.output.trim() === releaseSha,
    'Digest local foi construido pelo commit aprovado.',
    'Imagem por digest nao esta local ou seu rotulo de revisao diverge do commit aprovado.'));

  if (options.scope === 'deploy') {
    for (const key of externalEvidence) {
      checks.push(values.get(key) === 'confirmed'
        ? { id: `external.${key.toLowerCase()}`, status: 'pass', detail: `${key} possui confirmação operacional.` }
        : { id: `external.${key.toLowerCase()}`, status: 'blocked', detail: `${key} ainda não possui confirmação operacional.` });
    }
  }

  const status = checks.some((item) => item.status === 'fail')
    ? 'invalid'
    : checks.some((item) => item.status === 'blocked') ? 'blocked' : 'ready';
  return { schemaVersion: 1, status, scope: options.scope, checks };
}

export const pilotVpsPreflightExitCodes = {
  ready: 0,
  blocked: 2,
  invalid: 78,
  invalidArgument: 64,
} as const;
