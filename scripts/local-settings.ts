import { readFileSync } from 'node:fs';
import path from 'node:path';
import { root } from './process';

export const networkName = 'cirne-rotas-dev-loopback';
export const projectId = 'cirne-rotas-dev';
export const networkLabel = 'com.cirne.project';
export const bindingOption = 'com.docker.network.bridge.host_binding_ipv4';

export function assertProjectIdentity() {
  const config = readFileSync(path.join(root, 'supabase/config.toml'), 'utf8');
  if (config.match(/^project_id\s*=\s*"([^"]+)"\s*$/m)?.[1] !== projectId) {
    throw new Error('Identidade do projeto Supabase divergente. Nenhum serviço foi alterado.');
  }
}

export function configuredPorts(webPort = process.env.CIRNE_WEB_PORT ?? '3000') {
  const port = Number(webPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('CIRNE_WEB_PORT inválida.');
  const config = readFileSync(path.join(root, 'supabase/config.toml'), 'utf8');
  // Only numeric port declarations; never read or expose environment credentials.
  return [...new Set([port, ...[...config.matchAll(/^\s*(?:port|shadow_port)\s*=\s*(\d+)\s*$/gm)].map((match) => Number(match[1]))])];
}
