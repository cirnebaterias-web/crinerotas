'use client';

import { OfflineRouteScreen } from '@/features/routes/offline-route-screen';
import { VisitStartScreen } from '@/features/visits/visit-start-screen';
import { useEffect, useState } from 'react';

export function OfflineFieldShell() {
  const [pathname, setPathname] = useState<string | null>(null);
  useEffect(() => setPathname(window.location.pathname), []);
  if (pathname === null) return <main className="seller-offline-fallback">Abrindo dados salvos…</main>;
  const match = /^\/visit\/([0-9a-f-]+)$/i.exec(pathname);
  return match?.[1]
    ? <VisitStartScreen offlineId={match[1]} />
    : <OfflineRouteScreen />;
}
