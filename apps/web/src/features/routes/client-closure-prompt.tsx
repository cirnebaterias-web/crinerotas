'use client';

import { useRef, useState } from 'react';
import type { CanonicalRoute } from '@cirne/contracts';
import { sellerClient } from '../../lib/seller-client';
import { useModalFocus } from './modal-focus';

export function ClientClosurePrompt({ client, deviceId, onCancel, onClosed }: {
  client: CanonicalRoute['stops'][number]['client']; deviceId: string;
  onCancel(): void; onClosed(): Promise<void>;
}) {
  const [reason, setReason] = useState('Encerrou as atividades');
  const [observation, setObservation] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('A não-visita já foi registrada. A baixa do cliente é uma ação separada.');
  const idempotencyKey = useRef(crypto.randomUUID());
  const modal = useModalFocus(onCancel);
  async function confirm() {
    if (!reason.trim() || busy) return;
    setBusy(true); setMessage('Confirmando encerramento…');
    try {
      await sellerClient.closeClient(client.id, reason.trim(), observation.trim(), deviceId, idempotencyKey.current);
      await onClosed();
    } catch {
      setBusy(false); setMessage('Não foi possível baixar o cliente. A não-visita permanece registrada. Tente novamente.');
    }
  }
  return <div className="seller-evidence-overlay"><section ref={modal.dialogRef} onKeyDown={modal.onKeyDown} className="seller-stock-card client-close-confirm"
    role="dialog" aria-modal="true" aria-labelledby="route-client-close-title" aria-busy={busy}>
    <p className="seller-kicker">CADASTRO DO CLIENTE</p><h2 id="route-client-close-title">Este cliente encerrou as atividades?</h2>
    <p><strong>{client.name}</strong></p><p>A parada foi registrada como não realizada. Confirme somente se deseja também retirar o cliente das operações futuras. O histórico será preservado.</p>
    <label>Motivo da baixa<input autoFocus value={reason} maxLength={120} onChange={(event) => setReason(event.target.value)} /></label>
    <label>Observação (opcional)<textarea value={observation} maxLength={500} onChange={(event) => setObservation(event.target.value)} /></label>
    <p role="status">{message}</p><div className="seller-evidence-actions">
      <button type="button" className="seller-button seller-secondary" disabled={busy} onClick={onCancel}>Não baixar agora</button>
      <button type="button" className="seller-button seller-primary is-danger" disabled={busy || !reason.trim()} onClick={() => void confirm()}>Confirmar encerramento</button>
    </div>
  </section></div>;
}
