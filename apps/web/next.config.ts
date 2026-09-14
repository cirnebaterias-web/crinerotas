import type { NextConfig } from 'next';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import withSerwistInit from '@serwist/next';

function sourceRevision(directory: string): string {
  const hash = createHash('sha256');
  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (/\.(?:ts|tsx|css|svg)$/.test(entry.name)) hash.update(readFileSync(entryPath));
    }
  };
  visit(directory);
  return hash.digest('hex').slice(0, 16);
}

const appRevision = sourceRevision(path.resolve(import.meta.dirname, 'src'));
const withSerwist = withSerwistInit({
  swSrc: 'src/app/sw.ts',
  swDest: 'public/sw.js',
  disable: process.env.npm_lifecycle_event === 'typegen' || process.env.NODE_ENV !== 'production',
  register: true,
  reloadOnOnline: false,
  cacheOnNavigation: false,
  additionalPrecacheEntries: [
    { url: '/~offline', revision: appRevision },
    { url: '/icons/app-icon.svg', revision: appRevision },
    { url: '/icons/app-icon-maskable.svg', revision: appRevision },
  ],
});

const config: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: path.resolve(import.meta.dirname, '../..'),
  transpilePackages: ['@cirne/contracts', '@cirne/domain', '@cirne/config'],
  poweredByHeader: false,
  env: {
    NEXT_PUBLIC_OFFLINE_REVISION: appRevision,
  },
};
export default withSerwist(config);
