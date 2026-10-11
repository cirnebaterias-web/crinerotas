import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const web = path.resolve(import.meta.dirname, '../apps/web');
const environment = path.join(web, '.env.local');
if (existsSync(environment)) process.loadEnvFile(environment);
try {
  const { readServerConfig } = await import('@cirne/config/server');
  readServerConfig(process.env);
} catch (error) {
  console.error(JSON.stringify({ level: 'fatal', event: 'invalid_configuration',
    message: error instanceof Error ? error.message : 'Configuração inválida.' }));
  process.exit(1);
}
process.env.HOSTNAME = '127.0.0.1';
process.env.PORT ??= '3000';
await import(pathToFileURL(path.join(web, '.next/standalone/apps/web/server.js')).href);
