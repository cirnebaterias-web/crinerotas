import { cp } from 'node:fs/promises';
import path from 'node:path';

const web = path.resolve(import.meta.dirname, '../apps/web');
const destination = path.join(web, '.next/standalone/apps/web');
// Copy only generated assets and public files into the generated build tree.
await cp(path.join(web, '.next/static'), path.join(destination, '.next/static'), { recursive: true });
await cp(path.join(web, 'public'), path.join(destination, 'public'), { recursive: true });
