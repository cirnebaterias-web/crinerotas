'use client';

import { Brand } from '@/features/auth/brand';
import { apiErrorResponseSchema } from '@cirne/contracts';
import type { ReactNode } from 'react';

export class ScrapRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function ScrapShell({ children }: { children: ReactNode }) {
  return <div className="seller-app seller-route-page seller-scrap-flow"><header className="seller-topbar"><div className="seller-topbar-inner"><Brand /><a className="seller-button seller-quiet" href="/home">Início</a></div></header><main className="seller-route-main" id="main-content"><div className="seller-visit-start">{children}</div></main></div>;
}

export async function scrapRequest(path: string, options?: RequestInit): Promise<unknown> {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options });
  if (!response.ok) {
    const parsed = apiErrorResponseSchema.safeParse(await response.json().catch(() => null));
    const details = parsed.success ? parsed.data.error.details : undefined;
    if (response.status === 401) throw new ScrapRequestError('Entre novamente para continuar.', 401, parsed.success ? parsed.data.error.code : undefined, details);
    if (response.status === 403) throw new ScrapRequestError('Seu perfil não tem permissão para esta operação.', 403, parsed.success ? parsed.data.error.code : undefined, details);
    if (response.status === 409) throw new ScrapRequestError(parsed.success ? parsed.data.error.message : 'O registro mudou. Atualize a tela antes de confirmar novamente.', 409, parsed.success ? parsed.data.error.code : undefined, details);
    throw new ScrapRequestError('Não foi possível confirmar a operação. Seus dados continuam nesta tela.', response.status, parsed.success ? parsed.data.error.code : undefined, details);
  }
  return response.json();
}

export function scrapMutation(body: unknown, key: string, deviceId?: string): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': 'cirne-route-v1', 'idempotency-key': key, ...(deviceId ? { 'x-device-id': deviceId } : {}) }, body: JSON.stringify(body) };
}

export function localDate(offsetDays = 0) {
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const shifted = new Date(`${today}T12:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + offsetDays);
  return shifted.toISOString().slice(0, 10);
}
