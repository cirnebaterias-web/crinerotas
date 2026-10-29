import { parseArgs } from 'node:util';
import {
  pilotVpsPreflight,
  pilotVpsPreflightExitCodes,
  type PilotVpsPreflightScope,
} from './pilot-vps-preflight';

const json = process.argv.includes('--json');

try {
  const { values } = parseArgs({
    options: {
      'env-file': { type: 'string' },
      compose: { type: 'string' },
      caddyfile: { type: 'string' },
      scope: { type: 'string', default: 'deploy' },
      json: { type: 'boolean' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (!values['env-file'] || !['artifact', 'deploy'].includes(values.scope ?? '')) {
    throw new Error('invalid-arguments');
  }
  const result = await pilotVpsPreflight({
    envFilePath: values['env-file'],
    composePath: values.compose,
    caddyfilePath: values.caddyfile,
    scope: values.scope as PilotVpsPreflightScope,
    platform: process.platform,
  });
  console.log(values.json
    ? JSON.stringify(result)
    : [
      `Preflight VPS: ${result.status.toUpperCase()} (${result.scope})`,
      ...result.checks.map((item) => `${item.status === 'pass' ? 'OK' : item.status === 'blocked' ? 'BLOQUEADO' : 'FALHA'} ${item.id}: ${item.detail}`),
    ].join('\n'));
  process.exitCode = pilotVpsPreflightExitCodes[result.status];
} catch {
  const failure = {
    schemaVersion: 1,
    status: 'invalid' as const,
    message: 'Argumentos ou arquivos inválidos. Use --env-file CAMINHO [--scope artifact|deploy] [--json].',
  };
  console.error(json ? JSON.stringify(failure) : failure.message);
  process.exitCode = pilotVpsPreflightExitCodes.invalidArgument;
}
