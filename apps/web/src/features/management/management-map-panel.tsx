'use client';

import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import {
  apiErrorResponseSchema, managementMapPath, managementMapResponseSchema, type ManagementMapResponse,
} from '@cirne/contracts';
import type { ManagementMapPublicConfig } from '@cirne/config/server';

const LazyManagementRouteMap = lazy(() => import('./management-route-map'));

export function ManagementMapPanel({ serviceDate, config }: {
  serviceDate: string;
  config: ManagementMapPublicConfig;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [result, setResult] = useState<ManagementMapResponse | null>(null);
  const [message, setMessage] = useState('');
  const requestRef = useRef<AbortController | null>(null);

  useEffect(() => () => requestRef.current?.abort(), []);

  async function load() {
    if (!config.enabled) {
      setState('error');
      setMessage(config.reason === 'invalid'
        ? 'A configuração do provedor de mapa é inválida. A Central do dia continua disponível.'
        : 'O provedor de mapa ainda não foi configurado. A Central do dia continua disponível.');
      return;
    }
    requestRef.current?.abort();
    const controller = new AbortController(); requestRef.current = controller;
    setState('loading'); setMessage('');
    try {
      const url = new URL(managementMapPath, window.location.origin);
      url.searchParams.set('serviceDate', serviceDate);
      const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
      const body = await response.json().catch(() => null) as unknown;
      if (!response.ok) {
        const failure = apiErrorResponseSchema.safeParse(body);
        throw new Error(failure.success ? failure.data.error.message : 'Não foi possível carregar o mapa gerencial.');
      }
      const parsed = managementMapResponseSchema.safeParse(body);
      if (!parsed.success || parsed.data.serviceDate !== serviceDate) {
        throw new Error('O servidor retornou uma projeção inválida para o mapa.');
      }
      setResult(parsed.data); setState('ready');
    } catch (error) {
      if (controller.signal.aborted) return;
      setState('error');
      setMessage(error instanceof Error ? error.message : 'Não foi possível carregar o mapa gerencial.');
    }
  }

  function toggle() {
    if (open) { setOpen(false); return; }
    setOpen(true);
    if (!result && state !== 'loading') void load();
  }

  return <section className="management-map-panel" aria-labelledby="management-map-title">
    <div className="management-section-title"><div><h2 id="management-map-title">Mapa de apoio</h2>
      <p>Localização cadastral das paradas publicadas. Requer conexão e não substitui a lista.</p></div>
      <button type="button" className="seller-button seller-secondary" aria-expanded={open} onClick={toggle}>
        {open ? 'Ocultar mapa' : 'Mostrar mapa'}
      </button></div>
    {open && <div className="management-map-content">
      {state === 'loading' && <p role="status">Carregando projeção do mapa…</p>}
      {state === 'error' && <div className="seller-notice seller-error" role="alert"><p>{message}</p>
        {config.enabled && <button type="button" className="seller-button seller-secondary" onClick={() => void load()}>Tentar novamente</button>}
      </div>}
      {state === 'ready' && result && config.enabled && <>
        <dl className="management-map-summary"><div><dt>Rotas</dt><dd>{result.totals.routes}</dd></div>
          <div><dt>Paradas no mapa</dt><dd>{result.totals.positioned}</dd></div>
          <div><dt>Sem coordenadas</dt><dd>{result.totals.unpositioned}</dd></div></dl>
        <p className="seller-notice">{result.serverVisibilityNote}</p>
        <Suspense fallback={<p role="status">Preparando componente do mapa…</p>}>
          <LazyManagementRouteMap result={result} tileUrl={config.tileUrl} attribution={config.attribution} />
        </Suspense>
      </>}
    </div>}
  </section>;
}
