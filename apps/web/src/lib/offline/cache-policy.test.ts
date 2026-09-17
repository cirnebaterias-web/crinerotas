import { expect, it } from 'vitest';
import {
  isCurrentOfflineRevisionResponse,
  isFieldNavigationPath,
  isOfflineDemoPath,
  isSensitiveNetworkOnlyPath,
  isShellAssetPath,
  offlineRevisionResponseType,
} from './cache-policy';

it('limits offline navigation fallback to seller field routes', () => {
  expect(['/route', '/route/today', '/visit/local-id', '/sync', '/~offline'].every(isFieldNavigationPath)).toBe(true);
  expect(['/management', '/api/v1/me', '/auth/callback', '/login', '/'].some(isFieldNavigationPath)).toBe(false);
});

it('keeps API, authentication, and management network-only', () => {
  expect(['/api/v1/me', '/auth/callback', '/login', '/management/day'].every(isSensitiveNetworkOnlyPath)).toBe(true);
  expect(isSensitiveNetworkOnlyPath('/api/v10/public')).toBe(false);
});

it('separates the technical demo fallback from authenticated seller paths', () => {
  expect(['/demo/offline', '/demo/offline/visit/id', '/~offline-demo'].every(isOfflineDemoPath)).toBe(true);
  expect(['/route', '/visit/id', '/~offline', '/demo/offline-other'].some(isOfflineDemoPath)).toBe(false);
});

it('allows only versioned shell assets into the runtime asset cache', () => {
  expect(isShellAssetPath('/_next/static/chunks/app.js')).toBe(true);
  expect(isShellAssetPath('/icons/app-icon.svg')).toBe(true);
  expect(isShellAssetPath('/route/private.json')).toBe(false);
});

it('accepts only the current service worker revision response', () => {
  const current = { type: offlineRevisionResponseType, revision: 'current-revision' };
  expect(isCurrentOfflineRevisionResponse(current, 'current-revision')).toBe(true);
  expect(isCurrentOfflineRevisionResponse({ ...current, revision: 'stale-revision' }, 'current-revision')).toBe(false);
  expect(isCurrentOfflineRevisionResponse({ revision: 'current-revision' }, 'current-revision')).toBe(false);
  expect(isCurrentOfflineRevisionResponse(null, 'current-revision')).toBe(false);
});
