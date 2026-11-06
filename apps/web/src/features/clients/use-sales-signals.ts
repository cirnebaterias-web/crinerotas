'use client';

import { useEffect, useRef, useState } from 'react';
import type { SalesSignalsResponse } from '@cirne/contracts';
import { clientSalesClient, salesErrorMessage } from '../../lib/client-sales-client';
import { observeLocalAccessRevocation } from '../../lib/offline/access-revocation';

/** Only the visible authorized page is queried; route composition is never an input/output. */
export function useSalesSignals(sellerId: string, serviceDate: string, clientIds: string[], enabled: boolean) {
  const idsKey = clientIds.join(',');
  const scope = `${sellerId}/${serviceDate}/${idsKey}`;
  const [result, setResult] = useState<{ scope: string; data: SalesSignalsResponse } | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [locked, setLocked] = useState(false);
  const request = useRef(0);
  const activeController = useRef<AbortController | null>(null);

  useEffect(() => observeLocalAccessRevocation(() => {
    ++request.current; activeController.current?.abort(); setResult(null); setLocked(true); setBusy(false);
    setMessage('Seu acesso mudou. Valide novamente sua autorização para consultar sinais.');
  }), []);
  useEffect(() => {
    const suspend = () => { ++request.current; activeController.current?.abort(); setResult(null); setBusy(false); };
    const refresh = () => { suspend(); setRevision((value) => value + 1); };
    const visibility = () => { if (document.visibilityState === 'hidden') suspend(); else refresh(); };
    const restored = (event: PageTransitionEvent) => { if (event.persisted) refresh(); };
    window.addEventListener('blur', suspend); window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', visibility); window.addEventListener('pageshow', restored);
    return () => { window.removeEventListener('blur', suspend); window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pageshow', restored); };
  }, []);

  useEffect(() => {
    const current = ++request.current;
    const controller = new AbortController();
    activeController.current = controller;
    setResult(null); setBusy(false);
    if (locked) return;
    setMessage('');
    if (!enabled || !sellerId || !idsKey || document.visibilityState === 'hidden' || !/^\d{4}-\d{2}-\d{2}$/.test(serviceDate)) return;
    const disconnected = () => { ++request.current; controller.abort(); setResult(null); setBusy(false); setMessage('Sinais de compras disponíveis somente online.'); };
    window.addEventListener('offline', disconnected);
    if (!navigator.onLine) disconnected();
    else {
      setBusy(true);
      void clientSalesClient.signals({ sellerId, serviceDate, clientIds: idsKey.split(',') }, controller.signal)
        .then((data) => { if (current === request.current && !controller.signal.aborted) setResult({ scope, data }); })
        .catch((error) => { if (current === request.current && !controller.signal.aborted) setMessage(salesErrorMessage(error)); })
        .finally(() => { if (current === request.current) setBusy(false); });
    }
    return () => { ++request.current; controller.abort(); window.removeEventListener('offline', disconnected); };
  }, [sellerId, serviceDate, idsKey, scope, enabled, locked, revision]);

  return { data: !locked && enabled && result?.scope === scope ? result.data : null, message, busy,
    reload: () => setRevision((value) => value + 1), locked };
}
