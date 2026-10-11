'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  reviseScrapCollectionRequestSchema, reviseScrapReceiptRequestSchema,
  scrapCollectionRevisionPath, scrapCollectionReceiptPath, scrapCollectionSchema, scrapReceiptSchema,
  scrapPointListSchema, scrapPointsPath, type ScrapCollection, type ScrapPoint,
} from '@cirne/contracts';
import { scrapMutation, scrapRequest } from '@/features/scrap/scrap-ui';

function localDateTime(value: string) {
  const date = new Date(value);
  const two = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}T${two(date.getHours())}:${two(date.getMinutes())}`;
}

export function ScrapCorrectionForm({ collection, kind, onDone, onCancel }: {
  collection: ScrapCollection; kind: 'collection' | 'receipt'; onDone: () => Promise<void>; onCancel: () => void;
}) {
  const [weight, setWeight] = useState(kind === 'collection' ? collection.actualWeightKg : collection.receipt?.receivedWeightKg ?? '');
  const [term, setTerm] = useState(collection.receiptNumber);
  const [collectedAt, setCollectedAt] = useState(localDateTime(collection.collectedAt));
  const [destination, setDestination] = useState(collection.destinationType);
  const [pointId, setPointId] = useState(collection.concentrationPoint?.id ?? '');
  const [points, setPoints] = useState<ScrapPoint[]>([]);
  const [pointError, setPointError] = useState('');
  const [location, setLocation] = useState(collection.receipt?.receivedLocation ?? '');
  const [observation, setObservation] = useState(kind === 'receipt' ? collection.receipt?.observation ?? '' : '');
  const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const operation = useRef<{ key: string; body: string } | null>(null);
  const difference = kind === 'collection'
    ? Number(collection.receipt?.receivedWeightKg) - Number(weight.replace(',', '.'))
    : Number(weight.replace(',', '.')) - Number(collection.actualWeightKg);
  const divergent = Boolean(collection.receipt) && Number.isFinite(difference) && difference !== 0 &&
    (kind === 'receipt' || Number(weight.replace(',', '.')) !== Number(collection.actualWeightKg));
  useEffect(() => {
    if (kind !== 'collection') return;
    let active = true;
    void scrapRequest(scrapPointsPath).then((result) => { if (active) setPoints(scrapPointListSchema.parse(result).points); }).catch(() => { if (active) setPointError('Não foi possível carregar os pontos. O destino atual permanece disponível; atualize para escolher outro ponto.'); });
    return () => { active = false; };
  }, [kind]);
  async function submit(event: FormEvent) {
    event.preventDefault(); setError('');
    if (divergent && !observation.trim()) { setError('Informe uma observação para explicar a diferença entre peso coletado e recebido.'); return; }
    const base = { schemaVersion: 1 as const, expectedVersion: collection.version, reason };
    let body: unknown;
    if (kind === 'collection') {
      const instant = new Date(collectedAt);
      if (!Number.isFinite(instant.getTime())) { setError('Informe uma data e hora válidas da coleta.'); return; }
      const parsed = reviseScrapCollectionRequestSchema.safeParse({ ...base, actualWeightKg: weight.replace(',', '.'), receiptNumber: term,
        collectedAt: collectedAt === localDateTime(collection.collectedAt) ? collection.collectedAt : instant.toISOString(), destinationType: destination,
        ...(destination === 'concentration_point' ? { concentrationPointId: pointId } : {}),
        ...(observation.trim() ? { divergenceObservation: observation } : {}),
      });
      if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? 'Revise os campos e informe o motivo.'); return; }
      body = parsed.data;
    } else {
      const parsed = reviseScrapReceiptRequestSchema.safeParse({ ...base, receivedWeightKg: weight.replace(',', '.'), receivedLocation: location, ...(observation.trim() ? { observation } : {}) });
      if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? 'Revise os campos e informe o motivo.'); return; }
      body = parsed.data;
    }
    const encoded = JSON.stringify(body);
    if (!operation.current || operation.current.body !== encoded) operation.current = { key: crypto.randomUUID(), body: encoded };
    setBusy(true);
    try {
      const result = await scrapRequest(kind === 'collection' ? scrapCollectionRevisionPath(collection.id) : scrapCollectionReceiptPath(collection.id), { ...scrapMutation(body, operation.current.key), method: 'PATCH' });
      if (kind === 'collection') scrapCollectionSchema.parse(result); else scrapReceiptSchema.parse(result);
      await onDone();
    } catch (failure) { setError(failure instanceof Error && !(failure instanceof TypeError) ? failure.message : 'Não foi possível confirmar a correção. Seus dados continuam nesta tela; tente novamente.'); }
    finally { setBusy(false); }
  }
  return <form onSubmit={submit} aria-busy={busy}><h3>{kind === 'collection' ? 'Corrigir coleta' : 'Corrigir recebimento'} · versão {collection.version}</h3>
    <p className="seller-muted">A correção registra os valores anteriores, os novos valores, seu motivo e sua autoria. As ciências e fotografias do termo permanecem vinculadas ao registro.</p>
    <label>{kind === 'collection' ? 'Peso coletado corrigido em kg' : 'Peso recebido corrigido em kg'}<input required inputMode="decimal" value={weight} onChange={(e) => setWeight(e.target.value)} disabled={busy} /></label>
    {kind === 'collection' ? <>
      <label>Número do termo corrigido<input required maxLength={80} value={term} onChange={(e) => setTerm(e.target.value)} disabled={busy} /></label>
      <label>Data e hora da coleta corrigidas<input required type="datetime-local" value={collectedAt} onChange={(e) => setCollectedAt(e.target.value)} disabled={busy} /></label>
      <label>Destino corrigido<select value={destination} onChange={(e) => setDestination(e.target.value as typeof destination)} disabled={busy}><option value="headquarters">Matriz em Natal</option><option value="concentration_point">Ponto de concentração no interior</option></select></label>
      {destination === 'concentration_point' && <><label>Ponto de concentração corrigido<select required value={pointId} onChange={(e) => setPointId(e.target.value)} disabled={busy}><option value="">Selecione</option>{collection.concentrationPoint && !points.some((point) => point.id === collection.concentrationPoint?.id) && <option value={collection.concentrationPoint.id}>{collection.concentrationPoint.name} · destino atual</option>}{points.map((point) => <option key={point.id} value={point.id}>{point.name} · {point.address}</option>)}</select></label>{pointError && <p role="status">{pointError}</p>}</>}
    </> : <label>Local de recebimento corrigido<input required maxLength={300} value={location} onChange={(e) => setLocation(e.target.value)} disabled={busy} /></label>}
    {collection.receipt && <><p role="status">Diferença após correção: {Number.isFinite(difference) ? difference.toLocaleString('pt-BR') : '—'} kg</p><label>Observação da conferência {divergent ? '(obrigatória para divergência)' : '(opcional)'}<textarea required={divergent} maxLength={1000} rows={3} value={observation} onChange={(e) => setObservation(e.target.value)} disabled={busy} /></label></>}
    <label>Motivo da correção (obrigatório)<textarea required maxLength={500} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} disabled={busy} /></label>
    {error && <p role="alert" className="seller-notice seller-error">{error}</p>}
    <div className="seller-evidence-actions"><button type="button" className="seller-button seller-secondary" disabled={busy} onClick={onCancel}>Cancelar correção</button><button className="seller-button seller-primary" disabled={busy}>{busy ? 'Confirmando…' : 'Salvar correção auditada'}</button></div>
  </form>;
}
