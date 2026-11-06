'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ClientSalesResponse, SalesMetrics } from '@cirne/contracts';
import { clientSalesClient, ClientSalesHttpError, salesErrorMessage, type SalesReadContext } from '../../lib/client-sales-client';
import { observeLocalAccessRevocation } from '../../lib/offline/access-revocation';
import { ClientScrapSummaryCard } from './client-scrap-summary';

export const salesNumber = (value: number) => new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 }).format(value);
export function salesDate(value: string) {
  const [year, month, day] = value.slice(0, 10).split('-');
  return `${day}/${month}/${year}`;
}
function readContextFrom(data: ClientSalesResponse): SalesReadContext {
  const base = { salesGenerationId: data.salesGenerationId, asOfDate: data.asOfDate,
    clientVersion: data.clientVersion };
  return data.catalog.status === 'available'
    ? { ...base, catalogState: 'available', catalogGenerationId: data.catalog.generationId }
    : { ...base, catalogState: 'catalog_unavailable' };
}
export const cycleLabels: Record<SalesMetrics['cycleState'], string> = {
  no_history: 'Sem compra no histórico disponível', insufficient_history: 'Histórico insuficiente',
  within_cycle: 'Dentro do ciclo observado', cycle_exceeded: 'Ciclo superado',
};

export function SalesMetricsView({ metrics }: { metrics: SalesMetrics }) {
  return <dl className="client-sales-metrics">
    <div><dt>Dias desde a última compra</dt><dd>{metrics.daysSinceLastPurchase === null ? 'Sem compra no histórico disponível' : `${metrics.daysSinceLastPurchase} dias`}</dd>
      {metrics.lastPurchaseDate && <small>Compra positiva em {salesDate(metrics.lastPurchaseDate)}</small>}</div>
    <div><dt>Periodicidade observada · 12 meses</dt><dd>{metrics.periodicityDays === null ? 'Histórico insuficiente' : `${salesNumber(metrics.periodicityDays)} dias`}</dd>
      <small>{metrics.positivePurchaseDateCount} datas de compra · {metrics.intervalCount} intervalos. Referência histórica, sem garantia de pedido.</small></div>
    <div><dt>Média mensal de baterias</dt><dd>{salesNumber(metrics.averageMonthlyVolume)} un.</dd>
      <small>Volume líquido dos seis meses completos ÷ 6, incluindo meses sem registro e devoluções.</small></div>
  </dl>;
}

export function SalesCoverage({ data }: { data: Pick<ClientSalesResponse, 'asOfDate' | 'fetchedAt' | 'observedFrom' | 'observedThrough' | 'stale' | 'coverageLimited'> }) {
  return <div className="client-sales-coverage">
    <p>Referência: {salesDate(data.asOfDate)} · America/Sao_Paulo. Captura: {new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }).format(new Date(data.fetchedAt))}.</p>
    <p>Intervalo observado: {salesDate(data.observedFrom)} a {salesDate(data.observedThrough)}. A cobertura observada não comprova completude do extrato; ausência de registro não comprova ausência de compra.</p>
    {data.coverageLimited && <p className="client-sales-warning">A cobertura observada é menor que a janela dos indicadores.</p>}
    {data.stale && <p className="client-sales-warning" role="status">Última captura antiga: há mais de 24 horas. Os dados podem estar desatualizados.</p>}
  </div>;
}

export function ClientSalesContent({ data, busy, onPage }: { data: ClientSalesResponse; busy: boolean;
  onPage: (history: number, opportunities: number) => void }) {
  const scale = Math.max(1, ...data.chart.map((month) => Math.abs(month.netVolume)));
  return <>
    <SalesCoverage data={data} />
    {data.dataState === 'no_history' && <p className="seller-notice" role="status">Sem histórico disponível para este cliente. Isso não representa erro nem comprova ausência de compras fora da fonte.</p>}
    <SalesMetricsView metrics={data.metrics} />
    <p className="client-sales-cycle">{cycleLabels[data.metrics.cycleState]}. Sinal histórico para consulta; a decisão comercial permanece com você.</p>
    <section className="client-sales-section" aria-labelledby="client-sales-chart-title"><h3 id="client-sales-chart-title">Volume líquido registrado · seis meses completos</h3>
      <p>{salesDate(data.windows.chart.from)} a {salesDate(data.windows.chart.through)} · unidades da coluna Volume, vendas menos devoluções. O mês atual parcial não participa.</p>
      <div className="client-sales-chart" aria-hidden="true">{data.chart.map((month) => <div className="client-sales-chart-month" key={month.month}>
        <strong>{salesNumber(month.netVolume)}</strong>
        <div className="client-sales-bar-track"><span className={`client-sales-bar ${month.netVolume < 0 ? 'is-negative' : ''}`} style={{ height: `${Math.abs(month.netVolume) / scale * 45}%` }} /></div>
        <span>{month.month.slice(5)}/{month.month.slice(0, 4)}</span>
      </div>)}</div>
      <table className="client-sales-values"><caption>Valores do gráfico em unidades</caption><thead><tr><th scope="col">Mês/ano</th><th scope="col">Volume líquido</th><th scope="col">Registro</th></tr></thead>
        <tbody>{data.chart.map((month) => <tr key={month.month}><th scope="row">{month.month.slice(5)}/{month.month.slice(0, 4)}</th><td>{salesNumber(month.netVolume)}</td><td>{month.hasRecords ? 'Com registros' : 'Sem registros observados'}</td></tr>)}</tbody></table>
    </section>
    <section className="client-sales-section"><h3>Top 10 produtos por volume líquido positivo</h3><p>Janela de {salesDate(data.windows.history.from)} a {salesDate(data.windows.history.through)}.</p>
      {data.topProducts.length === 0 ? <p>Nenhum produto com saldo líquido positivo nesta janela.</p> : <ol className="client-sales-products">{data.topProducts.map((product) => <li key={product.sku}><strong>{product.catalogItem?.description ?? product.productDescription}</strong><span>SKU {product.sku} · {salesNumber(product.netVolume)} un.</span>
        {product.catalogMatch === 'matched' ? <small>Catálogo oficial · {product.catalogItem?.brand}{product.catalogItem?.amperageAh ? ` · ${product.catalogItem.amperageAh} Ah` : ''}</small>
          : <small className="client-sales-warning">{data.catalog.status === 'available'
            ? 'Cadastro pendente no catálogo oficial; dados preservados de Vendas.'
            : 'Catálogo indisponível; dados de Vendas preservados.'}</small>}</li>)}</ol>}
    </section>
    <section className="client-sales-section"><h3>Produtos sem compra registrada no histórico disponível</h3>
      {data.catalog.status === 'available' && <p>Catálogo oficial com {data.catalog.rowCount} produtos · versão {data.catalog.generationId.slice(0, 8)} · publicada em {new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }).format(new Date(data.catalog.publishedAt))}. Disponibilidade, estoque, preço e compatibilidade técnica não foram verificados.</p>}
      {data.opportunities.availability === 'catalog_unavailable' ? <p className="client-sales-warning" role="status">Catálogo oficial ainda não disponibilizado. O histórico e os indicadores permanecem disponíveis; oportunidades não foram calculadas.</p> : <>
        <p>{data.opportunities.coverage.matchedSalesProductCount} de {data.opportunities.coverage.salesProductCount} SKUs observados em Vendas possuem cadastro oficial nesta versão.</p>
        {data.opportunities.products.length === 0 ? <p>Nenhum produto nesta consulta.</p> : <ul className="client-sales-products">{data.opportunities.products.map((product) => <li key={product.factoryCode}><strong>{product.description}</strong><span>Cód. fábrica {product.factoryCode} · {product.brand}{product.amperageAh ? ` · ${product.amperageAh} Ah` : ''}</span>{product.commonApplications && <small>Aplicações informadas no cadastro: {product.commonApplications}</small>}</li>)}</ul>}
        <SalesPagination label="produtos sem compra registrada" page={data.opportunities.page} total={data.opportunities.totalPages} busy={busy}
          onPage={(page) => onPage(data.history.page, page)} />
      </>}
    </section>
    <section className="client-sales-section"><h3>Histórico de compras · 12 meses</h3><p>{salesDate(data.windows.history.from)} a {salesDate(data.windows.history.through)}. Mês atual: Parcial. {data.history.totalCount} registros.</p>
      {data.history.rows.length === 0 ? <p>Nenhum registro nesta janela.</p> : <ul className="client-sales-products">{data.history.rows.map((row, index) => <li key={`${data.history.page}-${index}`}>
        <span>{salesDate(row.saleDate)} · <strong>{row.kind === 'return' ? 'Devolução' : 'Venda'}</strong> · {salesNumber(row.volume)} un.</span>
        <strong>{row.productDescription}</strong><span>SKU {row.sku} · NF {row.invoiceNumber}</span>
      </li>)}</ul>}
      <SalesPagination label="histórico" page={data.history.page} total={data.history.totalPages} busy={busy}
        onPage={(page) => onPage(page, data.opportunities.availability === 'available' ? data.opportunities.page : 1)} />
    </section>
  </>;
}

function SalesPagination({ label, page, total, busy, onPage }: { label: string; page: number; total: number; busy: boolean; onPage: (page: number) => void }) {
  return <nav className="client-sales-pagination" aria-label={`Paginação de ${label}`}><button type="button" className="seller-button seller-secondary" disabled={busy || page <= 1} onClick={() => onPage(page - 1)}>Anterior</button>
    <span>Página {page} de {Math.max(total, 1)}</span><button type="button" className="seller-button seller-secondary" disabled={busy || page >= total} onClick={() => onPage(page + 1)}>Próxima</button></nav>;
}

export function ClientSalesDialog({ client, context, onClose }: { client: { id: string; name: string }; context?: SalesReadContext; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const controller = useRef<AbortController | null>(null);
  const requestId = useRef(0);
  const locked = useRef(false);
  const currentRead = useRef<{ historyPage: number; opportunityPage: number; context?: SalesReadContext }>({ historyPage: 1, opportunityPage: 1, context });
  const heading = useId();
  const [data, setData] = useState<ClientSalesResponse | null>(null);
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState('');
  const [conflict, setConflict] = useState(false);
  const [denied, setDenied] = useState(false);
  const [offline, setOffline] = useState(false);

  const load = useCallback(async (historyPage = 1, opportunityPage = 1, fixedContext?: SalesReadContext) => {
    if (locked.current) return;
    controller.current?.abort();
    const active = new AbortController(); controller.current = active;
    const current = ++requestId.current;
    // Pagination removes its controls while reading; keep focus on the persistent dialog header.
    if (dialog.current?.open) dialog.current.querySelector<HTMLButtonElement>('header button')?.focus();
    setData(null); setMessage(''); setBusy(true); setConflict(false);
    if (!navigator.onLine) { setOffline(true); setBusy(false); return; }
    setOffline(false);
    try {
      const result = await clientSalesClient.detail(client.id, { historyPage, opportunityPage, ...fixedContext }, active.signal);
      if (current === requestId.current && !locked.current) {
        currentRead.current = { historyPage, opportunityPage, context: readContextFrom(result) };
        setData(result);
      }
    } catch (error) {
      if (current !== requestId.current || active.signal.aborted) return;
      setMessage(salesErrorMessage(error));
      if (error instanceof ClientSalesHttpError) {
        setConflict(error.status === 409);
        if ([401, 403, 404].includes(error.status)) { locked.current = true; setDenied(true); }
      }
    } finally { if (current === requestId.current) setBusy(false); }
  }, [client.id]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.showModal();
    return () => { dialog.current?.close(); previousFocus?.focus(); };
  }, []);
  useEffect(() => {
    void load(1, 1, context);
    const hide = () => { locked.current = true; ++requestId.current; controller.current?.abort(); setData(null); setBusy(false); setOffline(false); setDenied(true); setMessage('Seu acesso mudou. Valide novamente sua autorização.'); };
    const stopObserving = observeLocalAccessRevocation(hide);
    const disconnected = () => { ++requestId.current; controller.current?.abort(); setData(null); setBusy(false); setOffline(true); };
    const restored = (event: PageTransitionEvent) => { if (event.persisted) hide(); };
    const suspend = () => { ++requestId.current; controller.current?.abort(); setData(null); setBusy(false); };
    const revalidate = () => {
      if (document.visibilityState !== 'visible' || locked.current) return;
      const read = currentRead.current;
      void load(read.historyPage, read.opportunityPage, read.context);
    };
    const visibility = () => { if (document.visibilityState === 'hidden') suspend(); else revalidate(); };
    window.addEventListener('offline', disconnected);
    window.addEventListener('pageshow', restored);
    window.addEventListener('blur', suspend); window.addEventListener('focus', revalidate);
    document.addEventListener('visibilitychange', visibility);
    return () => { ++requestId.current; controller.current?.abort(); stopObserving(); window.removeEventListener('offline', disconnected); window.removeEventListener('pageshow', restored);
      window.removeEventListener('blur', suspend); window.removeEventListener('focus', revalidate); document.removeEventListener('visibilitychange', visibility); };
  }, [context, load]);

  return <dialog ref={dialog} className="client-sales-dialog seller-app" aria-labelledby={heading} onCancel={(event) => { event.preventDefault(); onClose(); }}
    onKeyDown={(event) => {
      if (event.key !== 'Tab') return;
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]'))
        .filter((control) => control.getClientRects().length > 0);
      const first = controls[0]; const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
    <header className="client-sales-header"><div><p className="seller-kicker">HISTÓRICO DE COMPRAS</p><h2 id={heading}>{client.name}</h2></div><button type="button" autoFocus className="seller-button seller-secondary" onClick={onClose}>Fechar</button></header>
    <div className="client-sales-body" aria-busy={busy}>
      <ClientScrapSummaryCard clientId={client.id} />
      {busy && <p role="status">Consultando histórico comercial…</p>}
      {offline && <div className="seller-notice" role="status"><p>Histórico comercial disponível somente online. A rota e a visita continuam disponíveis pelos controles existentes.</p><button type="button" className="seller-button seller-secondary" disabled={denied} onClick={() => void load(1, 1, context)}>Tentar novamente</button></div>}
      {!offline && message && <div className="seller-notice" role="alert"><p>{message}</p>{!denied && <button type="button" className="seller-button seller-secondary" onClick={() => void load(1, 1, conflict ? undefined : context)}>{conflict ? 'Atualizar consulta' : 'Tentar novamente'}</button>}</div>}
      {data && <ClientSalesContent data={data} busy={busy}
        onPage={(history, opportunities) => void load(history, opportunities, readContextFrom(data))} />}
    </div>
  </dialog>;
}
