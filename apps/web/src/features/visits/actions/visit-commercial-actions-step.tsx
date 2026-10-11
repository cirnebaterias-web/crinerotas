'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  commercialActionsInputSchema,
  type CommercialAction,
  type CommercialActionsInput,
  type LocalAttachment,
  type LocalCompetitorPriceParameterSet,
  type LocalVisitDraft,
} from '@cirne/contracts';
import { compressStockPhoto, type CompressedStockPhoto } from '../stock/stock-photo-compression';

const actionTypes = [
  ['differentiated_price', 'Preço diferenciado'],
  ['seller_or_driver_incentive', 'Incentivo para vendedor/entregador'],
  ['retailer_incentive', 'Incentivo para o lojista'],
  ['purchase_combo', 'Combos de compras'],
  ['other', 'Outros'],
] as const;

type CompetitorAction = Extract<CommercialActionsInput['competitor'], { availability: 'identified' }>['actions'][number];

function todayInSaoPaulo() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const value = (type: 'year' | 'month' | 'day') => parts.find((part) => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function emptyAction(): CompetitorAction {
  const today = todayInSaoPaulo();
  return {
    offlineId: crypto.randomUUID(), competitorId: '', actionType: 'differentiated_price',
    description: '', validFrom: today, validUntil: today,
  } as CompetitorAction;
}

function EvidencePreview({ attachment }: { attachment: LocalAttachment }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    const next = URL.createObjectURL(attachment.blob); setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [attachment]);
  return url ? <img className="seller-action-evidence-preview" src={url} alt="Evidência da ação concorrente" /> : null;
}

export function VisitCommercialActionsStep({ draft, actions, parameters, attachments, onAddEvidence, onSave }: {
  draft: LocalVisitDraft;
  actions: CommercialAction[] | null;
  parameters: LocalCompetitorPriceParameterSet | null;
  attachments: LocalAttachment[];
  onAddEvidence: (targetOfflineId: string, photo: CompressedStockPhoto, fileName: string) => Promise<LocalAttachment>;
  onSave: (values: CommercialActionsInput) => Promise<void>;
}) {
  const saved = draft.commercialActions;
  const [acknowledged, setAcknowledged] = useState(() => new Set(saved?.ownAcknowledgements.map((item) => item.actionId) ?? []));
  const [availability, setAvailability] = useState<'not_identified' | 'identified'>(saved?.competitor.availability ?? 'not_identified');
  const [competitorActions, setCompetitorActions] = useState<CompetitorAction[]>(() =>
    saved?.competitor.availability === 'identified' ? saved.competitor.actions : []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const evidenceByTarget = useMemo(() => new Map(attachments
    .filter((item) => item.purpose === 'commercial_action_evidence' && item.targetOfflineId)
    .map((item) => [item.targetOfflineId!, item])), [attachments]);

  function update(index: number, patch: Partial<CompetitorAction>) {
    setCompetitorActions((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
  }

  async function addEvidence(index: number, file?: File) {
    if (!file) return;
    setBusy(true); setError('');
    try {
      const attachment = await onAddEvidence(competitorActions[index]!.offlineId, await compressStockPhoto(file), file.name);
      update(index, { evidenceAttachmentOfflineId: attachment.offlineId });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Não foi possível salvar a foto.');
    } finally { setBusy(false); }
  }

  async function submit(event: FormEvent) {
    event.preventDefault(); setError('');
    if (actions === null) {
      setError('Catálogo Heliar indisponível. Reconecte-se para consultar as ações vigentes antes de salvar.'); return;
    }
    if (actions.some((action) => !acknowledged.has(action.id))) {
      setError('Confirme o repasse de todas as ações Heliar vigentes.'); return;
    }
    const input: CommercialActionsInput = {
      ownAcknowledgements: actions.map((action) => ({
        actionId: action.id, title: action.title, validFrom: action.validFrom,
        validUntil: action.validUntil, presented: true as const,
      })),
      competitor: availability === 'not_identified'
        ? { availability: 'not_identified' }
        : { availability: 'identified', actions: competitorActions },
    };
    const parsed = commercialActionsInputSchema.safeParse(input);
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? 'Revise os campos das ações.'); return; }
    setBusy(true);
    try { await onSave(parsed.data); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Não foi possível salvar.'); setBusy(false); }
  }

  return <form className="seller-commercial-actions" onSubmit={submit} aria-busy={busy}>
    <p className="seller-kicker">AÇÕES COMERCIAIS</p>
    <h2>Heliar</h2>
    <p className="seller-muted">Confirme que você apresentou ao PDV cada ação vigente.</p>
    {actions === null && <p className="seller-notice seller-error" role="alert">Catálogo Heliar indisponível neste aparelho. Reconecte-se antes de confirmar o repasse das ações vigentes.</p>}
    {actions?.length === 0 && <p className="seller-notice">Não há ações Heliar vigentes para esta data.</p>}
    <div className="seller-own-actions">
      {actions?.map((action) => <article className="seller-own-action-card" key={action.id}>
        <div className="seller-own-action-banner">
          {action.bannerUrl ? <img src={action.bannerUrl} alt="" /> : <span aria-hidden="true">H</span>}
        </div>
        <div><p className="seller-kicker">VÁLIDA DE {new Date(`${action.validFrom}T12:00:00`).toLocaleDateString('pt-BR')} A {new Date(`${action.validUntil}T12:00:00`).toLocaleDateString('pt-BR')}</p>
          <h3>{action.title}</h3><p>{action.description}</p>
          <label className="seller-action-confirm"><input type="checkbox" checked={acknowledged.has(action.id)}
            onChange={(event) => setAcknowledged((current) => {
              const next = new Set(current);
              if (event.target.checked) next.add(action.id); else next.delete(action.id);
              return next;
            })} />
            Apresentei esta ação ao PDV</label>
        </div>
      </article>)}
    </div>

    <hr />
    <h2>Concorrência</h2>
    <p className="seller-muted">Você identificou alguma ação comercial da concorrência?</p>
    <div className="seller-choice-grid">
      <label><input type="radio" name="action-availability" checked={availability === 'not_identified'}
        onChange={() => { setAvailability('not_identified'); setCompetitorActions([]); }} /> Não identifiquei</label>
      <label><input type="radio" name="action-availability" checked={availability === 'identified'}
        onChange={() => { setAvailability('identified'); setCompetitorActions((current) => current.length ? current : [emptyAction()]); }} /> Identifiquei ação</label>
    </div>
    {availability === 'identified' && <div className="seller-competitor-actions">
      {competitorActions.map((action, index) => <fieldset key={action.offlineId}>
        <legend>Ação {index + 1}</legend>
        <div className="seller-form-grid">
          <label>Concorrente<select value={action.competitorId} required onChange={(event) => update(index, { competitorId: event.target.value })}>
            <option value="">Selecione</option>{parameters?.values.competitors.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select></label>
          <label>Tipo de ação<select value={action.actionType} onChange={(event) => update(index, { actionType: event.target.value as CompetitorAction['actionType'], otherType: undefined })}>
            {actionTypes.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
          {action.actionType === 'other' && <label>Outro tipo<input value={action.otherType ?? ''} required maxLength={120} onChange={(event) => update(index, { otherType: event.target.value })} /></label>}
          <label>Início da validade<input type="date" required value={action.validFrom} onChange={(event) => update(index, { validFrom: event.target.value })} /></label>
          <label>Término da validade<input type="date" required value={action.validUntil} onChange={(event) => update(index, { validUntil: event.target.value })} /></label>
        </div>
        <label>Descrição da ação<textarea required maxLength={1200} rows={4} value={action.description} onChange={(event) => update(index, { description: event.target.value })} /></label>
        <label className="seller-photo-picker">Foto de evidência (opcional)<input type="file" accept="image/*" capture="environment" disabled={busy}
          onChange={(event) => void addEvidence(index, event.target.files?.[0])} /></label>
        {evidenceByTarget.get(action.offlineId) && <EvidencePreview attachment={evidenceByTarget.get(action.offlineId)!} />}
        <button className="seller-link-danger" type="button" onClick={() => setCompetitorActions((current) => current.filter((_, itemIndex) => itemIndex !== index))}>Remover ação</button>
      </fieldset>)}
      <button className="seller-button seller-secondary" type="button" disabled={competitorActions.length >= 10}
        onClick={() => setCompetitorActions((current) => [...current, emptyAction()])}>+ Adicionar outra ação</button>
    </div>}
    {error && <p className="seller-notice seller-error" role="alert">{error}</p>}
    <button className="seller-button seller-primary" type="submit" disabled={busy || actions === null}>{busy ? 'Salvando…' : 'Salvar ações comerciais'}</button>
  </form>;
}
