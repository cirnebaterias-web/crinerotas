'use client';

import { useEffect, useRef, useState } from 'react';
import { clientSheetSyncPath, clientSheetSyncResultSchema, clientSheetSyncStatusSchema,
  type ClientSheetSyncStatus } from '@cirne/contracts';
import { scrapMutation, scrapRequest } from '@/features/scrap/scrap-ui';

export function ClientSheetSyncPanel({ onUpdated }: { onUpdated: () => Promise<unknown> }) {
  const [state, setState] = useState<ClientSheetSyncStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [issuePage, setIssuePage] = useState(0);
  const pendingKey = useRef<string | null>(null);
  const inFlight = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    void scrapRequest(clientSheetSyncPath, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) })
      .then((result) => { if (!controller.signal.aborted) setState(clientSheetSyncStatusSchema.parse(result)); })
      .catch(() => { if (!controller.signal.aborted) setMessage('Não foi possível consultar a conexão. Tente consultar o estado novamente.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  async function refresh() {
    setLoading(true); setMessage('');
    try {
      setState(clientSheetSyncStatusSchema.parse(await scrapRequest(clientSheetSyncPath, { signal: AbortSignal.timeout(15_000) })));
      setIssuePage(0);
    } catch { setMessage('Não foi possível consultar o estado. A última informação permanece exibida.'); }
    finally { setLoading(false); }
  }
  async function synchronize() {
    if (inFlight.current || !state?.configured) return;
    inFlight.current = true; setBusy(true); setMessage('');
    pendingKey.current ??= crypto.randomUUID();
    try {
      const result = clientSheetSyncResultSchema.parse(await scrapRequest(clientSheetSyncPath, {
        ...scrapMutation({ trigger: 'manual', idempotencyKey: pendingKey.current }, pendingKey.current),
        signal: AbortSignal.timeout(90_000),
      }));
      setState((current) => current ? { ...current, latest: result } : current);
      setIssuePage(0);
      if (result.status !== 'running') pendingKey.current = null;
      if (result.status === 'failed') setMessage('A atualização falhou. Confira a conexão e tente uma nova atualização.');
      else if (result.status === 'running') setMessage('Atualização em andamento. Consulte o estado para acompanhar.');
      else {
        setMessage('Atualização confirmada. Confira os importados, ignorados e pendentes abaixo.');
        try { await onUpdated(); }
        catch { setMessage('Atualização confirmada, mas a lista de clientes não pôde ser recarregada. Atualize a página.'); }
      }
    } catch {
      setMessage('Não foi possível confirmar a atualização. Use Recuperar tentativa para obter o resultado sem duplicar a importação; depois será possível iniciar uma nova atualização.');
    } finally { inFlight.current = false; setBusy(false); }
  }
  const result = state?.latest;
  const issues = result?.issues ?? [];
  const visibleIssues = issues.slice(issuePage * 20, (issuePage + 1) * 20);
  return <section className="seller-stock-card seller-stock-form" aria-labelledby="client-sheet-sync-title" aria-busy={busy || loading}>
    <h2 id="client-sheet-sync-title">Atualização pelo Google Planilhas</h2>
    <p>Aba: Base clientes. Programação: <strong>06:00 e 13:00 — horário de Brasília</strong>.</p>
    {loading && <p role="status">Consultando conexão…</p>}
    {state && <p>{state.configured ? 'Conexão configurada; o acesso ao Google é verificado em cada atualização.'
      : 'Integração inativa: configure a credencial Google, a planilha e o mapeamento das carteiras no servidor.'}</p>}
    <p>{state?.scheduleEnabled ? 'Agendamento habilitado na configuração; os disparos dependem do agendador instalado na VPS.'
      : 'Agendamento ainda não ativado na VPS.'}</p>
    <div className="seller-evidence-actions">
      <button type="button" className="seller-button seller-primary" disabled={busy || loading || !state?.configured}
        onClick={() => void synchronize()}>{busy ? 'Atualizando…' : pendingKey.current ? 'Recuperar tentativa' : 'Atualizar agora'}</button>
      <button type="button" className="seller-button seller-secondary" disabled={busy || loading}
        onClick={() => void refresh()}>Consultar estado</button>
    </div>
    {message && <p className="seller-notice" role="status">{message}</p>}
    {result ? <div>
      <h3>Última execução visível ao seu perfil</h3>
      <p>{new Date(result.startedAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })} · {result.trigger === 'manual' ? 'Manual' : 'Agendada'} · {
        result.status === 'running' ? 'Em andamento' : result.status === 'failed' ? 'Falhou' : result.status === 'completed_with_pending' ? 'Concluída com pendências' : 'Concluída'}</p>
      <p>Importados: {result.acceptedCount} · Ignorados (OUTROS): {result.ignoredCount} · Pendentes de revisão: {result.pendingCount}</p>
      {result.errorCode && <p role="alert">A execução não foi concluída. Verifique a conexão/configuração antes de tentar novamente.</p>}
      {issues.length > 0 && <><h3>Pendências de revisão</h3>
        <p>Corrija a linha na planilha original ou o vínculo da carteira e clique em Atualizar agora.</p>
        <ul>{visibleIssues.map((item, index) => <li key={`${item.rowNumber}-${index}`}><strong>Linha {item.rowNumber}:</strong> {item.message}</li>)}</ul>
        {issues.length > 20 && <nav className="seller-evidence-actions" aria-label="Paginação de pendências">
          <button type="button" className="seller-button seller-secondary" disabled={issuePage === 0} onClick={() => setIssuePage((page) => page - 1)}>Pendências anteriores</button>
          <button type="button" className="seller-button seller-secondary" disabled={(issuePage + 1) * 20 >= issues.length} onClick={() => setIssuePage((page) => page + 1)}>Próximas pendências</button>
        </nav>}
      </>}
    </div> : state?.configured && <p>Nenhuma execução visível ao seu perfil. Isso não significa ausência de execuções de outros usuários.</p>}
  </section>;
}
