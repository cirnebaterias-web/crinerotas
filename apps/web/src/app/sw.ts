/// <reference lib="webworker" />

import { CacheFirst, NetworkOnly, Serwist, type PrecacheEntry, type RuntimeCaching } from 'serwist';
import {
  isFieldNavigationPath,
  isOfflineDemoPath,
  isSensitiveNetworkOnlyPath,
  isShellAssetPath,
  offlineRevisionRequestType,
  offlineRevisionResponseType,
} from '@/lib/offline/cache-policy';

declare global {
  interface WorkerGlobalScope {
    __SW_MANIFEST: (PrecacheEntry | string)[];
  }
}

declare const self: ServiceWorkerGlobalScope;

const offlineRevision = process.env.NEXT_PUBLIC_OFFLINE_REVISION;

self.addEventListener('message', (event) => {
  if (event.data?.type !== offlineRevisionRequestType || !event.ports[0]) return;
  event.ports[0].postMessage({
    type: offlineRevisionResponseType,
    revision: offlineRevision,
  });
});

const runtimeCaching: RuntimeCaching[] = [
  {
    matcher: ({ sameOrigin, url }) => sameOrigin && isSensitiveNetworkOnlyPath(url.pathname),
    handler: new NetworkOnly(),
  },
  {
    matcher: ({ request, sameOrigin, url }) =>
      sameOrigin && request.mode === 'navigate' && isFieldNavigationPath(url.pathname),
    handler: new NetworkOnly(),
  },
  {
    matcher: ({ sameOrigin, url }) => sameOrigin && isShellAssetPath(url.pathname),
    handler: new CacheFirst({ cacheName: 'cirne-rotas-shell-assets-v1' }),
  },
  {
    matcher: /.*/,
    handler: new NetworkOnly(),
  },
];

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  cacheId: 'cirne-rotas-shell',
  clientsClaim: true,
  skipWaiting: false,
  precacheOptions: { cleanupOutdatedCaches: true },
  runtimeCaching,
  fallbacks: {
    entries: [{
      url: '/~offline-demo',
      matcher: ({ request }) => request.mode === 'navigate' && isOfflineDemoPath(new URL(request.url).pathname),
    }, {
      url: '/~offline',
      matcher: ({ request }) => request.mode === 'navigate' && isFieldNavigationPath(new URL(request.url).pathname) && !isOfflineDemoPath(new URL(request.url).pathname),
    }],
  },
});

serwist.addEventListeners();
