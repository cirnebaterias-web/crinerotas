'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { scrapCollectionInputSchema, type LocalVisitDraft, type LocalAttachment, type VisitScrapInput, type ScrapPoint } from '@cirne/contracts';
import { PickupScheduleForm } from '@/features/scrap/pickup-schedule-form';
import { compressStockPhoto, type CompressedStockPhoto } from '../stock/stock-photo-compression';

function Photo({ attachment }: { attachment: LocalAttachment }) {
  const [url, setUrl] = useState('');
  useEffect(() => { const next = URL.createObjectURL(attachment.blob); setUrl(next); return () => URL.revokeObjectURL(next); }, [attachment.blob]);
  return <li>{url && <img src={url} alt="Fotografia do termo assinado" />}<span>{attachment.status === 'verified' ? 'Confirmada no servidor' : 'Salva no aparelho · envio pendente'}</span></li>;
}

export function VisitScrapStep({ draft, attachments, points, onSave, onAddEvidence }: {
  draft: LocalVisitDraft; attachments: LocalAttachment[]; points: ScrapPoint[];
  onSave: (value: VisitScrapInput) => Promise<void>;
  onAddEvidence: (collectionOfflineId: string, photo: CompressedStockPhoto, fileName: string) => Promise<LocalAttachment>;
}) {
  const saved = draft.scrap;
  const [availability, setAvailability] = useState<VisitScrapInput['availability'] | ''>(saved?.availability ?? '');
  const [collectionId] = useState(() => saved?.collection?.offlineId ?? attachments.find((item) => item.purpose === 'scrap_receipt')?.targetOfflineId ?? crypto.randomUUID());
  const [weight, setWeight] = useState(saved?.collection?.actualWeightKg ?? '');
  const [term, setTerm] = useState(saved?.collection?.receiptNumber ?? '');
  const [collectedAt] = useState(() => saved?.collection?.collectedAt ?? new Date().toISOString());
  const [destination, setDestination] = useState<'headquarters' | 'concentration_point'>(saved?.collection?.destinationType ?? 'headquarters');
  const [pointId, setPointId] = useState(saved?.collection?.concentrationPointId ?? '');
  const [clientSigned, setClientSigned] = useState(Boolean(saved?.collection?.clientSigned));
  const [sellerSigned, setSellerSigned] = useState(Boolean(saved?.collection?.sellerSigned));
  const [twoCopies, setTwoCopies] = useState(Boolean(saved?.collection?.twoCopies));
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const photos = attachments.filter((item) => item.purpose === 'scrap_receipt' && item.targetOfflineId === collectionId);
  async function save(value: VisitScrapInput) { setBusy(true); setError(''); try { await onSave(value); } catch (failure) { setError(failure instanceof Error ? failure.message : 'Não foi possível salvar a resposta.'); } finally { setBusy(false); } }
  async function collect(event: FormEvent) {
    event.preventDefault(); setError('');
    const parsed = scrapCollectionInputSchema.safeParse({ offlineId: collectionId, actualWeightKg: weight.replace(',', '.'), receiptNumber: term, collectedAt, clientSigned, sellerSigned, twoCopies, destinationType: destination, ...(destination === 'concentration_point' ? { concentrationPointId: pointId } : {}), attachmentOfflineIds: photos.map((p) => p.offlineId) });
    if (!parsed.success) { setError('Informe kg positivos, número do termo, destino, as três confirmações e ao menos uma foto legível.'); return; }
    await save({ availability: 'collected', collection: parsed.data });
  }
  async function add(file?: File) { if (!file) return; setBusy(true); setError(''); try { await onAddEvidence(collectionId, await compressStockPhoto(file), file.name); } catch (failure) { setError(failure instanceof Error ? failure.message : 'Não foi possível salvar a foto.'); } finally { setBusy(false); } }
  if (saved) return <section className="seller-stock-card seller-scrap-flow">
    <p className="seller-kicker">TAREFA DA VISITA</p><h2>Sucata registrada</h2>
    <p>{saved.availability === 'collected'
      ? `${saved.collection?.actualWeightKg} kg coletados · termo ${saved.collection?.receiptNumber}`
      : saved.availability === 'scheduled'
        ? `${saved.schedule?.estimatedWeightKg} kg previstos para ${saved.schedule?.desiredDate}`
        : 'Sem sucata nesta visita.'}</p>
    <p>{saved.persistenceState === 'synced' ? 'Confirmada no servidor' : 'Salva no aparelho · sincronização pendente'}.</p>
    {saved.availability === 'collected' && <ul className="seller-photo-grid">{photos.map((photo) =>
      <Photo key={photo.offlineId} attachment={photo} />)}</ul>}
    <p className="seller-muted">Este registro não pode ser sobrescrito neste fluxo. Para corrigir, contate a gestão.</p>
  </section>;
  return <section className="seller-stock-card seller-scrap-flow"><p className="seller-kicker">TAREFA DA VISITA</p><h2>Sucata</h2><fieldset disabled={busy}><legend>O que aconteceu nesta visita?</legend><div className="seller-choice-grid">
    {([['collected', 'Coleta realizada pelo vendedor'], ['scheduled', 'Agendamento para a logística'], ['none', 'Sem sucata']] as const).map(([value, label]) => <label key={value}><input type="radio" name="scrap-availability" checked={availability === value} onChange={() => { setAvailability(value); setError(''); }} />{label}</label>)}
  </div></fieldset>
  {availability === 'none' && <button className="seller-button seller-primary" disabled={busy} onClick={() => void save({ availability: 'none' })}>Confirmar sem sucata</button>}
  {availability === 'scheduled' && <PickupScheduleForm onSave={(schedule) => save({ availability: 'scheduled', schedule })} />}
  {availability === 'collected' && <form onSubmit={collect} aria-busy={busy}><h3>Coleta realizada pelo vendedor</h3><p>Cliente: {draft.client?.name}</p><p>Data e hora: {new Date(collectedAt).toLocaleString('pt-BR')}</p>
    <label>Peso coletado em kg<input required inputMode="decimal" value={weight} onChange={(e) => setWeight(e.target.value)} disabled={busy} /></label>
    <label>Número do termo/canhoto<input required maxLength={80} value={term} onChange={(e) => setTerm(e.target.value)} disabled={busy} /></label>
    <label>Destino previsto<select value={destination} onChange={(e) => setDestination(e.target.value as typeof destination)} disabled={busy}><option value="headquarters">Matriz em Natal</option><option value="concentration_point">Ponto de concentração no interior</option></select></label>
    {destination === 'concentration_point' && <><label>Ponto de concentração<select required value={pointId} onChange={(e) => setPointId(e.target.value)} disabled={busy}><option value="">Selecione um ponto ativo</option>{points.map((p) => <option value={p.id} key={p.id}>{p.name} · {p.address}</option>)}</select></label>{points.length === 0 && <p className="seller-notice">Nenhum ponto cadastrado neste aparelho. Reconecte-se ou solicite o cadastro à Administração.</p>}</>}
    <p className="seller-muted">A logística confirmará o recebimento pela Cirne após conferir a entrega.</p>
    <label className="seller-action-confirm"><input type="checkbox" required checked={clientSigned} onChange={(e) => setClientSigned(e.target.checked)} disabled={busy} />Cliente entregou a sucata e assinou o termo</label>
    <label className="seller-action-confirm"><input type="checkbox" required checked={sellerSigned} onChange={(e) => setSellerSigned(e.target.checked)} disabled={busy} />Recebi a sucata e assinei como vendedor</label>
    <label className="seller-action-confirm"><input type="checkbox" required checked={twoCopies} onChange={(e) => setTwoCopies(e.target.checked)} disabled={busy} />Termo físico preenchido em duas vias</label>
    <label className="seller-photo-picker">Fotografias legíveis do termo assinado (obrigatórias, até 4)<input type="file" accept="image/*" capture="environment" disabled={busy || photos.length >= 4} onChange={(e) => { void add(e.target.files?.[0]); e.target.value = ''; }} /></label>
    <ul className="seller-photo-grid">{photos.map((p) => <Photo attachment={p} key={p.offlineId} />)}</ul>
    <button className="seller-button seller-primary" disabled={busy}>{busy ? 'Salvando…' : 'Salvar coleta'}</button>
  </form>}
  {error && <p className="seller-notice seller-error" role="alert">{error}</p>}
  </section>;
}
