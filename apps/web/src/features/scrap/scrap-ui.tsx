'use client';

import { Brand } from '@/features/auth/brand';
import type { ReactNode } from 'react';

export function ScrapShell({ children }: { children: ReactNode }) {
  return <div className="seller-app seller-route-page seller-scrap-flow"><header className="seller-topbar"><div className="seller-topbar-inner"><Brand /><a className="seller-button seller-quiet" href="/home">Início</a></div></header><main className="seller-route-main" id="main-content"><div className="seller-visit-start">{children}</div></main></div>;
}

export async function scrapRequest(path: string, options?: RequestInit): Promise<unknown> {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options });
  if (!response.ok) {
    if (response.status === 401) throw new Error('Entre novamente para continuar.');
    if (response.status === 403) throw new Error('Seu perfil não tem permissão para esta operação.');
    if (response.status === 409) throw new Error('O registro mudou. Atualize a tela antes de confirmar novamente.');
    throw new Error('Não foi possível confirmar a operação. Seus dados continuam nesta tela.');
  }
  return response.json();
}

export function scrapMutation(body: unknown, key: string, deviceId?: string): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': 'cirne-route-v1', 'idempotency-key': key, ...(deviceId ? { 'x-device-id': deviceId } : {}) }, body: JSON.stringify(body) };
}

export function localDate() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
