'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { z } from 'zod';
import { scrapCollectionsPath, scrapCollectionSchema, scrapCollectionReceiptPath, scrapCollectionAttachmentsPath, confirmScrapReceiptRequestSchema, type ScrapCollection, type MeResponse } from '@cirne/contracts';
import { sellerClient } from '@/lib/seller-client';
import { ScrapShell, scrapRequest, scrapMutation } from '@/features/scrap/scrap-ui';
import { ScrapCorrectionForm } from './scrap-correction-form';
import { ScrapRevisionHistory } from './scrap-revision-history';

const collectionList = z.object({ collections: z.array(scrapCollectionSchema), totals: z.object({ collectedKg: z.string(), receivedKg: z.string(), scheduledKg: z.string() }) });
const evidenceList = z.object({ attachments: z.array(z.object({ offlineId: z.string(), signedUrl: z.string().url() })) });

function ReceiptForm({ collection, onDone }: { collection: ScrapCollection; onDone: () => Promise<void> }) {
  const [weight, setWeight] = useState(''); const [location, setLocation] = useState(''); const [observation, setObservation] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const operation = useRef<{ key: string; body: string } | null>(null);
  const difference = Number(weight.replace(',', '.')) - Number(collection.actualWeightKg);
  async function submit(event: FormEvent) {
    event.preventDefault(); setError('');
    if (difference !== 0 && !observation.trim()) { setError('Explique a diferença entre o peso coletado e o conferido.'); return; }
    const parsed = confirmScrapReceiptRequestSchema.safeParse({ schemaVersion: 1, expectedVersion: collection.version, receivedWeightKg: weight.replace(',', '.'), receivedLocation: location, ...(observation.trim() ? { observation } : {}) });
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? 'Revise os campos.'); return; }
    const encoded = JSON.stringify(parsed.data);
    if (!operation.current || operation.current.body !== encoded) operation.current = { key: crypto.randomUUID(), body: encoded };
    setBusy(true);
    try { await scrapRequest(scrapCollectionReceiptPath(collection.id), scrapMutation(parsed.data, operation.current.key)); await onDone(); } catch (failure) { setError(failure instanceof Error ? failure.message : 'Não foi possível confirmar.'); } finally { setBusy(false); }
  }
  return <form onSubmit={submit} aria-busy={busy}><h3>OK de recebimento pela Cirne</h3><p>Coletado pelo vendedor: {collection.actualWeightKg} kg</p><label>Peso conferido em kg<input required inputMode="decimal" value={weight} onChange={(e) => setWeight(e.target.value)} disabled={busy} /></label>
    {weight && Number.isFinite(difference) && <p role="status">Diferença: {difference.toLocaleString('pt-BR')} kg</p>}
    <label>Local do recebimento<input required maxLength={300} value={location} onChange={(e) => setLocation(e.target.value)} disabled={busy} /></label>
    <label>Observação {difference !== 0 ? '(obrigatória para divergência)' : '(opcional)'}<textarea required={difference !== 0} rows={3} maxLength={1000} value={observation} onChange={(e) => setObservation(e.target.value)} disabled={busy} /></label>
    {error && <p role="alert" className="seller-notice seller-error">{error}</p>}<button className="seller-button seller-primary" disabled={busy}>{busy ? 'Confirmando…' : 'Confirmar recebimento pela Cirne'}</button>
  </form>;
}

function CollectionDetail({ collection, canReceive, canCorrect, onReload }: { collection: ScrapCollection; canReceive: boolean; canCorrect: boolean; onReload: () => Promise<void> }) {
  const [photos, setPhotos] = useState<{ offlineId: string; signedUrl: string }[]>([]); const [error, setError] = useState('');
  const [correcting, setCorrecting] = useState<'collection' | 'receipt' | null>(null); const [correctionMessage, setCorrectionMessage] = useState('');
  async function evidence() { setError(''); try { setPhotos(evidenceList.parse(await scrapRequest(scrapCollectionAttachmentsPath(collection.id))).attachments); } catch (failure) { setError(failure instanceof Error ? failure.message : 'Não foi possível consultar comprovantes.'); } }
  return <section className="seller-stock-card"><h2>{collection.client.name}</h2><p>{collection.client.address}</p><dl>
    <dt>Cliente entregou / vendedor recebeu</dt><dd>{collection.seller.displayName} · {new Date(collection.collectedAt).toLocaleString('pt-BR')} · {collection.actualWeightKg} kg</dd>
    <dt>Termo físico assinado em duas vias</dt><dd>{collection.receiptNumber}</dd><dt>Registro no servidor</dt><dd>{new Date(collection.serverSavedAt).toLocaleString('pt-BR')}</dd>
    <dt>Destino declarado</dt><dd>{collection.concentrationPoint ? `${collection.concentrationPoint.name} · ${collection.concentrationPoint.address}` : 'Matriz em Natal'}</dd>
    <dt>Recebimento pela Cirne</dt><dd>{collection.receipt ? `${collection.receipt.receivedWeightKg} kg · ${collection.receipt.receivedBy.displayName} · ${new Date(collection.receipt.receivedAt).toLocaleString('pt-BR')} · ${collection.receipt.receivedLocation}` : 'Aguardando conferência e confirmação da logística'}</dd>
    <dt>Preservação dos registros</dt><dd>{collection.retentionUntil ? `Até pelo menos ${new Date(collection.retentionUntil).toLocaleDateString('pt-BR')}` : 'Ciclo pendente · registros preservados'}</dd>
    {collection.receipt && <><dt>Diferença de peso</dt><dd>{(Number(collection.receipt.receivedWeightKg) - Number(collection.actualWeightKg)).toLocaleString('pt-BR')} kg · {collection.receipt.observation ?? 'Sem observação'}</dd></>}
  </dl><button className="seller-button seller-secondary" onClick={() => void evidence()}>Ver comprovantes assinados</button>{error && <p role="alert">{error}</p>}<ul className="seller-photo-grid">{photos.map((p) => <li key={p.offlineId}><a href={p.signedUrl} target="_blank" rel="noreferrer"><img src={p.signedUrl} alt="Comprovante assinado de entrega de sucata" /></a></li>)}</ul>
  {canReceive && !collection.receipt && <ReceiptForm key={`${collection.id}-${collection.version}`} collection={collection} onDone={onReload} />}
  {canCorrect && <section aria-label="Correção auditada"><h3>Correção auditada · versão {collection.version}</h3>
    {correctionMessage && <p role="status" className="seller-notice">{correctionMessage}</p>}
    {correcting ? <ScrapCorrectionForm key={`${collection.id}-${collection.version}-${correcting}`} collection={collection} kind={correcting}
      onCancel={() => setCorrecting(null)} onDone={async () => { await onReload(); setCorrecting(null); setCorrectionMessage('Correção confirmada no servidor. Os valores anteriores permanecem no histórico.'); }} />
      : <div className="seller-evidence-actions"><button className="seller-button seller-secondary" onClick={() => { setCorrecting('collection'); setCorrectionMessage(''); }}>Corrigir coleta</button>
        {collection.receipt && <button className="seller-button seller-secondary" onClick={() => { setCorrecting('receipt'); setCorrectionMessage(''); }}>Corrigir recebimento</button>}
      </div>}
  </section>}
  <ScrapRevisionHistory collectionId={collection.id} version={collection.version} />
  </section>;
}

export function ScrapManagement() {
  const [identity, setIdentity] = useState<MeResponse | null>(null); const [collections, setCollections] = useState<ScrapCollection[]>([]);
  const [totals, setTotals] = useState({ collectedKg: '0', receivedKg: '0', scheduledKg: '0' });
  const [selected, setSelected] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(true);
  async function load() { setBusy(true); setError(''); try { const user = await sellerClient.identity(); if (!user.capabilities.includes('scrap.read_operations')) throw new Error('Seu perfil não tem acesso à gestão de sucata.'); setIdentity(user); const result = collectionList.parse(await scrapRequest(scrapCollectionsPath)); setCollections(result.collections); setTotals(result.totals); } catch (failure) { setError(failure instanceof Error ? failure.message : 'Não foi possível consultar a operação.'); } finally { setBusy(false); } }
  useEffect(() => { void load(); }, []);
  const collection = collections.find((c) => c.id === selected);
  const canCorrect = Boolean(identity?.capabilities.includes('scrap.manage_operations') && identity.roles.some((role) => role === 'manager' || role === 'administrator'));
  return <ScrapShell><p className="seller-kicker">ADMINISTRAÇÃO · LOGÍSTICA · GESTÃO</p><h1>Coleta de sucata</h1><nav aria-label="Gestão"><a className="seller-button seller-secondary" href="/management/commercial-actions">Ações comerciais</a>{identity?.capabilities.includes('scrap.manage_points') && <a className="seller-button seller-secondary" href="/management/scrap/points">Pontos de concentração</a>}</nav>
    <section className="seller-progress" aria-label="Volumes separados"><p>Coletados pelo vendedor: <strong>{totals.collectedKg} kg</strong></p><p>Recebidos pela Cirne: <strong>{totals.receivedKg} kg</strong></p><p>Agendados para logística: <strong>{totals.scheduledKg} kg previstos</strong></p></section>
    <div className="seller-evidence-actions"><a className="seller-button seller-secondary" aria-current="page" href="/management/scrap">Coletas do vendedor</a><a className="seller-button seller-secondary" href="/management/scrap/agenda">Agenda pendente</a><button className="seller-button seller-secondary" disabled={busy} onClick={() => void load()}>Atualizar</button></div>
    {busy && <p role="status">Carregando registros…</p>}{error && <p className="seller-notice seller-error" role="alert">{error}</p>}
    <ul className="seller-stop-list">{collections.map((c) => <li key={c.id}><button className="seller-task-card" onClick={() => setSelected(c.id)} aria-pressed={selected === c.id}><span><strong>{c.client.name} · {c.actualWeightKg} kg coletados</strong><small>{c.seller.displayName} · {new Date(c.collectedAt).toLocaleString('pt-BR')} · termo {c.receiptNumber}</small><small>{c.concentrationPoint?.name ?? 'Matriz em Natal'}</small></span><span>{c.status === 'received' ? 'Recebido pela Cirne' : 'Aguardando recebimento'}</span></button></li>)}</ul>{!busy && collections.length === 0 && <p>Nenhuma coleta registrada.</p>}{collection && <CollectionDetail key={collection.id} collection={collection} canReceive={Boolean(identity?.capabilities.includes('scrap.receive'))} canCorrect={canCorrect} onReload={load} />}
  </ScrapShell>;
}
