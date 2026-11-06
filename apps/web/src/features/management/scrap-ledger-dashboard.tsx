'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { scrapLedgerAnalyticsPath, scrapLedgerSyncPath, scrapLedgerSyncStatusSchema, type ScrapLedgerSyncStatus } from '@cirne/contracts';
import { z } from 'zod';

const analytics = z.object({ generationId: z.string().uuid().nullable(), view: z.enum(['entries', 'balances']), page: z.number(), pageSize: z.number(), totalCount: z.number(), rows: z.array(z.record(z.string(), z.unknown())), totals: z.record(z.string(), z.string()), trendMethod: z.string() });
const labels: Record<string, string> = {
  sequence: 'Seq', operation: 'Operação', client_external_reference: 'CNPJ/CPF', client_name: 'Cliente', legal_name: 'Razão Social', trade_name: 'Nome Fantasia', city: 'Cidade', seller: 'Vendedor', portfolio_seller: 'Vendedor Carteira', portfolio_city: 'Cidade da Carteira', occurred_on: 'Data', source_weight_kg: 'Peso', price: 'Preço', total: 'Total', signed_weight_kg: 'Peso kg', invoice_number: 'NFe', status: 'Situação', settlement_method: 'Forma Quitação', duplicate: 'Duplicata', commitment_term: 'T. Compromisso', settlement_term: 'T. Quitação', notes: 'Observação', client_status: 'Situação Cliente', group_name: 'Grupo Empresarial', balance_kg: 'Saldo (kg)', balance_status: 'Situação do Saldo', original_debits_kg: 'Débitos Originais (kg)', obligation_kg: 'Obrigação de Sucata (kg)', credits_kg: 'Créditos (kg)', pending_since: 'Início da Pendência', overdue_days: 'Dias em Atraso', overdue_band: 'Faixa de Atraso', last_movement_on: 'Última Movimentação', last_debit_on: 'Data do Último Débito', last_debit_weight_kg: 'Peso do Último Débito (kg)', last_credit_on: 'Data do Último Crédito', last_credit_weight_kg: 'Peso do Último Crédito (kg)', entry_count: 'Qtd. Lançamentos', trend: 'Tendência',
};
export const scrapLedgerColumns = {
  entries: ['sequence', 'operation', 'client_external_reference', 'client_name', 'city', 'seller', 'invoice_number', 'occurred_on', 'source_weight_kg', 'price', 'total', 'status', 'settlement_method', 'duplicate', 'commitment_term', 'settlement_term', 'notes', 'signed_weight_kg', 'portfolio_seller', 'trade_name', 'portfolio_city', 'group_name', 'client_status'],
  balances: ['client_status', 'group_name', 'legal_name', 'client_external_reference', 'trade_name', 'city', 'portfolio_seller', 'original_debits_kg', 'obligation_kg', 'credits_kg', 'balance_kg', 'balance_status', 'pending_since', 'overdue_days', 'overdue_band', 'last_movement_on', 'last_debit_on', 'last_debit_weight_kg', 'last_credit_on', 'last_credit_weight_kg', 'entry_count', 'trend'],
} as const;
const terms: Record<string, string> = { growing: 'Crescimento do débito', falling: 'Queda do débito', stable: 'Estável', debit: 'Débito', credit: 'Crédito' };
const totalColumns = new Set(['source_weight_kg', 'signed_weight_kg', 'original_debits_kg', 'obligation_kg', 'credits_kg', 'balance_kg', 'last_credit_weight_kg']);
const formatKg = (value: string) => `${new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 3, maximumFractionDigits: 3 }).format(Number(value))} kg`;

async function responseBody(response: Response) {
  const data = await response.json();
  if (!response.ok) throw new Error((data as { message?: string }).message ?? 'Não foi possível concluir a operação.');
  return data;
}

export function ScrapLedgerDashboard() {
  const [status, setStatus] = useState<ScrapLedgerSyncStatus | null>(null);
  const [view, setView] = useState<'entries' | 'balances'>('balances');
  const [search, setSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<z.infer<typeof analytics> | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const requestSequence = useRef(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setAppliedSearch(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const load = useCallback(async (signal?: AbortSignal) => {
    const requestId = ++requestSequence.current;
    setBusy(true);
    setMessage('');
    try {
      const [statusResponse, analyticsResponse] = await Promise.all([
        fetch(scrapLedgerSyncPath, { cache: 'no-store', credentials: 'include', signal }),
        fetch(`${scrapLedgerAnalyticsPath}?view=${view}&search=${encodeURIComponent(appliedSearch)}&page=${page}`, { cache: 'no-store', credentials: 'include', signal }),
      ]);
      const nextStatus = scrapLedgerSyncStatusSchema.parse(await responseBody(statusResponse));
      const nextData = analytics.parse(await responseBody(analyticsResponse));
      if (requestId !== requestSequence.current) return;
      setStatus(nextStatus);
      setData(nextData);
    } catch (error) {
      if (signal?.aborted || requestId !== requestSequence.current) return;
      setMessage(error instanceof Error ? error.message : 'Dados de sucata indisponíveis.');
    } finally {
      if (requestId === requestSequence.current) setBusy(false);
    }
  }, [view, appliedSearch, page]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function sync() {
    setBusy(true);
    setMessage('');
    try {
      await responseBody(await fetch(scrapLedgerSyncPath, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-csrf-token': 'cirne-route-v1' }, body: JSON.stringify({ trigger: 'manual', idempotencyKey: crypto.randomUUID() }) }));
      await load();
      setMessage('Conta-corrente atualizada com sucesso.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Não foi possível atualizar.');
    } finally { setBusy(false); }
  }

  const cols = scrapLedgerColumns[view];
  return <section className="seller-stock-card scrap-ledger-dashboard">
    <header><div><p className="seller-kicker">FONTE OFICIAL · GOOGLE PLANILHAS</p><h2>Conta-corrente de sucata</h2><p>Atualização automática às 08:00 e 18:00 · America/Sao_Paulo.</p></div><button className="seller-button seller-primary" disabled={busy || !status?.configured} onClick={() => void sync()}>{busy ? 'Atualizando…' : 'Atualizar agora'}</button></header>
    {status?.latestRun && <p>Última execução: {new Date(status.latestRun.startedAt).toLocaleString('pt-BR')} · {status.latestRun.status === 'published' ? 'Concluída' : status.latestRun.status === 'failed' ? 'Falhou' : 'Em andamento'} · {status.latestRun.entryCount} movimentos · {status.latestRun.balanceCount} saldos.</p>}
    {message && <p className="seller-notice" role="status">{message}</p>}
    <div className="seller-evidence-actions"><button className="seller-button seller-secondary" aria-pressed={view === 'balances'} onClick={() => { setView('balances'); setPage(1); }}>Saldo por cliente</button><button className="seller-button seller-secondary" aria-pressed={view === 'entries'} onClick={() => { setView('entries'); setPage(1); }}>Sucatas · histórico</button><label>Filtrar por Nome Fantasia, CNPJ ou Razão Social<input value={search} maxLength={120} placeholder="Digite o nome ou CNPJ" onChange={(event) => { setSearch(event.target.value); setPage(1); }} /></label></div>
    {view === 'balances' && <p className="seller-muted">Tendência: média do débito líquido dos 3 meses mais recentes comparada aos 3 anteriores.</p>}
    <div className="management-table-scroll"><table className="client-sales-values"><thead><tr>{cols.map((key) => <th key={key}>{labels[key]}</th>)}</tr></thead><tbody>{data?.rows.map((row, index) => <tr key={`${page}-${index}`}>{cols.map((key) => <td key={key}>{terms[String(row[key])] ?? String(row[key] ?? '—')}</td>)}</tr>)}</tbody>{data && <tfoot><tr>{cols.map((key, index) => index === 0 ? <th key={key} scope="row">Total filtrado</th> : <td key={key}>{totalColumns.has(key) ? formatKg(data.totals[key] ?? '0') : ''}</td>)}</tr></tfoot>}</table></div>
    {data?.rows.length === 0 && <p role="status">Nenhum cliente encontrado para este filtro.</p>}
    {data && <nav className="client-sales-pagination" aria-label="Paginação da conta-corrente"><button className="seller-button seller-secondary" disabled={busy || page <= 1} onClick={() => setPage(page - 1)}>Anterior</button><span>Página {page} · {data.totalCount} registros</span><button className="seller-button seller-secondary" disabled={busy || page * data.pageSize >= data.totalCount} onClick={() => setPage(page + 1)}>Próxima</button></nav>}
  </section>;
}
