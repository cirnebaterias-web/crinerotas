'use client';

import { useEffect, useState } from 'react';
import { scrapCollectionRevisionsPath, scrapCollectionRevisionsSchema } from '@cirne/contracts';
import { scrapRequest } from '@/features/scrap/scrap-ui';
import type { z } from 'zod';

type Revision = z.infer<typeof scrapCollectionRevisionsSchema>['revisions'][number];
const fields = [
  ['actualWeightKg', 'Peso coletado (kg)'], ['receivedWeightKg', 'Peso recebido (kg)'],
  ['receiptNumber', 'Número do termo'], ['collectedAt', 'Data/hora da coleta'],
  ['destinationType', 'Destino'], ['concentrationPoint', 'Ponto de concentração'],
  ['receivedLocation', 'Local de recebimento'], ['observation', 'Observação da conferência'],
  ['receivedBy', 'Responsável pelo recebimento'], ['receivedAt', 'Data/hora do recebimento'],
  ['status', 'Estado'], ['version', 'Versão'], ['retentionUntil', 'Preservação até'],
] as const;

function display(value: unknown, key: string): string {
  if (value === undefined || value === null) return '—';
  if (typeof value === 'object') {
    const item = value as Record<string, unknown>;
    return [item.name ?? item.displayName, item.address].filter(Boolean).join(' · ') || '—';
  }
  if (key === 'destinationType') return value === 'headquarters' ? 'Matriz em Natal' : 'Ponto de concentração';
  if (key === 'status') return value === 'received' ? 'Recebido pela Cirne' : 'Aguardando recebimento';
  if (key === 'collectedAt' || key === 'receivedAt' || key === 'retentionUntil') {
    const date = new Date(String(value)); return Number.isFinite(date.getTime()) ? date.toLocaleString('pt-BR') : String(value);
  }
  return String(value);
}

export function ScrapRevisionHistory({ collectionId, version }: { collectionId: string; version: number }) {
  const [revisions, setRevisions] = useState<Revision[]>([]); const [error, setError] = useState(''); const [busy, setBusy] = useState(true);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true; setBusy(true); setError(''); setRevisions([]);
    void scrapRequest(scrapCollectionRevisionsPath(collectionId)).then((value) => { if (active) setRevisions(scrapCollectionRevisionsSchema.parse(value).revisions); })
      .catch((failure) => { if (active) setError(failure instanceof Error ? failure.message : 'Não foi possível carregar o histórico.'); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [collectionId, version, retry]);
  return <section aria-label="Histórico de correções"><h3>Histórico de correções</h3>
    {busy && <p role="status">Carregando histórico…</p>}{error && <><p className="seller-notice" role="alert">{error}</p><button className="seller-button seller-secondary" disabled={busy} onClick={() => setRetry((value) => value + 1)}>Tentar carregar histórico</button></>}
    {!busy && !error && revisions.length === 0 && <p>Nenhuma correção registrada.</p>}
    {revisions.map((revision) => {
      const before = revision.before as Record<string, unknown> | null; const after = revision.after as Record<string, unknown> | null;
      const changed = fields.filter(([key]) => JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key]));
      return <article className="seller-stock-card" key={revision.id}><h4>{revision.kind === 'collection' ? 'Correção da coleta' : 'Correção do recebimento'}</h4><p>{revision.actor.displayName} · {new Date(revision.changedAt).toLocaleString('pt-BR')}</p><p><strong>Motivo:</strong> {revision.reason}</p>
        <div className="seller-scrap-history-table"><table><caption>Valores alterados</caption><thead><tr><th scope="col">Campo</th><th scope="col">Antes</th><th scope="col">Depois</th></tr></thead><tbody>{changed.map(([key, label]) => <tr key={key}><th scope="row">{label}</th><td>{display(before?.[key], key)}</td><td>{display(after?.[key], key)}</td></tr>)}</tbody></table></div>
      </article>;
    })}
  </section>;
}
