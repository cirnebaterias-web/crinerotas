const fieldRoutes = ['/route', '/visit', '/sync', '/~offline', '/demo/offline', '/~offline-demo'] as const;
const sensitiveRoutes = ['/api/v1', '/auth', '/login', '/management'] as const;

export const offlineRevisionRequestType = 'cirne-rotas:offline-revision-request';
export const offlineRevisionResponseType = 'cirne-rotas:offline-revision-response';

export function isCurrentOfflineRevisionResponse(value: unknown, expectedRevision: string) {
  if (!value || typeof value !== 'object') return false;
  const response = value as Record<string, unknown>;
  return response.type === offlineRevisionResponseType && response.revision === expectedRevision;
}

function isPathInside(pathname: string, prefix: string) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function isFieldNavigationPath(pathname: string) {
  return fieldRoutes.some((prefix) => isPathInside(pathname, prefix));
}

export function isOfflineDemoPath(pathname: string) {
  return isPathInside(pathname, '/demo/offline') || pathname === '/~offline-demo';
}

export function isSensitiveNetworkOnlyPath(pathname: string) {
  return sensitiveRoutes.some((prefix) => isPathInside(pathname, prefix));
}

export function isShellAssetPath(pathname: string) {
  return pathname.startsWith('/_next/static/') || pathname.startsWith('/icons/');
}
