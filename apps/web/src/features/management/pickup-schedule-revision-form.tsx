'use client';

import { useRef, useState, type FormEvent } from 'react';
import { revisePickupScheduleRequestSchema, pickupScheduleSchema, scrapSchedulePath, type PickupSchedule } from '@cirne/contracts';
import { localDate, scrapRequest, scrapMutation } from '@/features/scrap/scrap-ui';

export function PickupScheduleRevisionForm({ schedule, onDone, onCancel }: {
  schedule: PickupSchedule; onDone: () => Promise<void>; onCancel: () => void;
}) {
  const [weight, setWeight] = useState(schedule.estimatedWeightKg);
  const [date, setDate] = useState(schedule.desiredDate);
  const [period, setPeriod] = useState(schedule.period);
  const [observation, setObservation] = useState(schedule.observation ?? '');
  const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const operation = useRef<{ key: string; body: string } | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault(); setError('');
    if (date <= localDate()) { setError('Escolha uma data futura para revisar o agendamento.'); return; }
    const parsed = revisePickupScheduleRequestSchema.safeParse({ schemaVersion: 1, expectedVersion: schedule.version,
      estimatedWeightKg: weight.replace(',', '.'), desiredDate: date, period, observation, reason });
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? 'Revise os campos e informe o motivo da alteração.'); return; }
    const encoded = JSON.stringify(parsed.data);
    if (!operation.current || operation.current.body !== encoded) operation.current = { key: crypto.randomUUID(), body: encoded };
    setBusy(true);
    try {
      pickupScheduleSchema.parse(await scrapRequest(scrapSchedulePath(schedule.id), { ...scrapMutation(parsed.data, operation.current.key), method: 'PATCH' }));
      await onDone();
    } catch (failure) { setError(failure instanceof Error && !(failure instanceof TypeError) ? failure.message : 'Não foi possível confirmar a revisão. Seus dados continuam nesta tela; tente novamente.'); }
    finally { setBusy(false); }
  }
  return <form onSubmit={submit} aria-busy={busy}><h3>Revisar agendamento · versão {schedule.version}</h3><p className="seller-muted">A alteração registra seu motivo e preserva os dados anteriores. O agendamento continua pendente para a logística.</p>
    <label>Peso estimado revisado em kg<input required inputMode="decimal" value={weight} onChange={(e) => setWeight(e.target.value)} disabled={busy} /></label>
    <label>Nova data desejada<input required type="date" min={localDate()} value={date} onChange={(e) => setDate(e.target.value)} disabled={busy} /></label>
    <label>Período revisado<select value={period} onChange={(e) => setPeriod(e.target.value as typeof period)} disabled={busy}><option value="morning">Manhã</option><option value="afternoon">Tarde</option></select></label>
    <label>Observação revisada (opcional)<textarea maxLength={1000} rows={3} value={observation} onChange={(e) => setObservation(e.target.value)} disabled={busy} /></label>
    <label>Motivo da revisão (obrigatório)<textarea required maxLength={500} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} disabled={busy} /></label>
    {error && <p className="seller-notice seller-error" role="alert">{error}</p>}
    <div className="seller-evidence-actions"><button type="button" className="seller-button seller-secondary" disabled={busy} onClick={onCancel}>Cancelar revisão</button><button className="seller-button seller-primary" disabled={busy}>{busy ? 'Confirmando…' : 'Salvar revisão auditada'}</button></div>
  </form>;
}
