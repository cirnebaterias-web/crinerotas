'use client';

import { useState, type FormEvent } from 'react';
import { pickupScheduleInputSchema, type PickupScheduleInput } from '@cirne/contracts';
import { localDate } from './scrap-ui';

export function PickupScheduleForm({ initial, onSave }: { initial?: PickupScheduleInput; onSave: (value: PickupScheduleInput) => Promise<void> }) {
  const [weight, setWeight] = useState(initial?.estimatedWeightKg ?? '');
  const [date, setDate] = useState(initial?.desiredDate ?? '');
  const [period, setPeriod] = useState<PickupScheduleInput['period'] | ''>(initial?.period ?? '');
  const [observation, setObservation] = useState(initial?.observation ?? '');
  const [offlineId] = useState(() => initial?.offlineId ?? crypto.randomUUID());
  const [requestedAt] = useState(() => initial?.requestedAt ?? new Date().toISOString());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault(); setError('');
    if (date <= localDate()) { setError('Escolha uma data futura para a coleta.'); return; }
    const parsed = pickupScheduleInputSchema.safeParse({ offlineId, estimatedWeightKg: weight.replace(',', '.'), desiredDate: date, period, observation, requestedAt });
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? 'Revise os campos.'); return; }
    setBusy(true);
    try { await onSave(parsed.data); } catch (failure) { setError(failure instanceof Error ? failure.message : 'Não foi possível salvar.'); } finally { setBusy(false); }
  }
  return <form onSubmit={submit} aria-busy={busy}><p className="seller-muted">Informe a previsão para a logística. O peso será conferido na coleta.</p>
    <label>Peso estimado em kg<input required inputMode="decimal" value={weight} onChange={(e) => setWeight(e.target.value)} disabled={busy} /></label>
    <label>Data desejada<input required type="date" min={localDate()} value={date} onChange={(e) => setDate(e.target.value)} disabled={busy} /></label>
    <fieldset><legend>Período</legend><div className="seller-choice-grid">{([['morning', 'Manhã'], ['afternoon', 'Tarde']] as const).map(([value, label]) => <label key={value}><input required type="radio" name="pickup-period" checked={period === value} onChange={() => setPeriod(value)} disabled={busy} />{label}</label>)}</div></fieldset>
    <label>Observação (opcional)<textarea rows={3} maxLength={1000} value={observation} onChange={(e) => setObservation(e.target.value)} disabled={busy} /></label>
    {error && <p className="seller-notice seller-error" role="alert">{error}</p>}<button className="seller-button seller-primary" disabled={busy}>{busy ? 'Salvando…' : 'Salvar agendamento'}</button>
  </form>;
}
