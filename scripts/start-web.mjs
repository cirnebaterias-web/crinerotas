import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const web = path.resolve(import.meta.dirname, '../apps/web');
const environment = path.join(web, '.env.local');
if (existsSync(environment)) process.loadEnvFile(environment);
process.env.HOSTNAME = '127.0.0.1';
process.env.PORT ??= '3000';
await import(pathToFileURL(path.join(web, '.next/standalone/apps/web/server.js')).href);
