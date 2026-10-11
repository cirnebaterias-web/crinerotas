'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  stockInputSchema,
  type CompetitorStockLine,
  type LocalVisitDraft,
  type StockInput,
} from '@cirne/contracts';
import {
  COMPETITOR_STOCK_BRANDS,
  COMPETITOR_STOCK_TECHNOLOGIES,
} from './own-product-catalog';

const wholeNumber = /^\d+$/u;

type CompetitorBrand = CompetitorStockLine['brand'];
type CompetitorRow = {
  id: string;
  amperage: string;
  technology: string;
  quantity: string;
};
type CompetitorGroup = {
  id: string;
  brand: CompetitorBrand;
  otherBrand: string;
  rows: CompetitorRow[];
};

function emptyRow(id: string): CompetitorRow {
  return { id, amperage: '', technology: '', quantity: '' };
}

function savedGroups(draft: LocalVisitDraft): CompetitorGroup[] {
  const groups: CompetitorGroup[] = [];
  for (const [index, line] of (draft.stock?.competitorLines ?? []).entries()) {
    const group = groups.find((item) => item.brand === line.brand
      && item.otherBrand === (line.otherBrand ?? ''));
    const row = {
      id: 'saved-' + index,
      amperage: String(line.amperage),
      technology: line.technology,
      quantity: String(line.quantity),
    };
    if (group) group.rows.push(row);
    else groups.push({
      id: 'group-' + index,
      brand: line.brand,
      otherBrand: line.otherBrand ?? '',
      rows: [row],
    });
  }
  return groups;
}

interface VisitCompetitorStockStepProps {
  draft: LocalVisitDraft;
  onSave: (values: StockInput) => Promise<void>;
}

export function VisitCompetitorStockStep({ draft, onSave }: VisitCompetitorStockStepProps) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const nextGroup = useRef(1);
  const nextRow = useRef(1);
  const pendingFocus = useRef<string | null>(null);
  const controlRefs = useRef<Record<string, HTMLElement | null>>({});
  const [groups, setGroups] = useState(() => savedGroups(draft));
  const [activeId, setActiveId] = useState(() => savedGroups(draft)[0]?.id ?? null);
  const [noCompetition, setNoCompetition] = useState(
    draft.stock?.competitorLines !== undefined && draft.stock.competitorLines.length === 0,
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [firstError, setFirstError] = useState<string>();
  const [focusAttempt, setFocusAttempt] = useState(0);
  const [announcement, setAnnouncement] = useState('');
  const [saving, setSaving] = useState(false);

  const activeGroup = groups.find((group) => group.id === activeId);

  useEffect(() => { titleRef.current?.focus(); }, []);
  useEffect(() => {
    if (firstError) controlRefs.current[firstError]?.focus();
  }, [firstError, focusAttempt, activeId]);
  useEffect(() => {
    if (!pendingFocus.current) return;
    controlRefs.current[pendingFocus.current]?.focus();
    pendingFocus.current = null;
  }, [groups, activeId]);

  const registerControl = (key: string) => (element: HTMLElement | null) => {
    controlRefs.current[key] = element;
  };
  const fieldId = (id: string, field: string) => 'competitor-stock-' + id + '-' + field;
  const fieldError = (id: string, field: string) => errors[id + '.' + field];
  const clearErrors = () => { setErrors({}); setFirstError(undefined); };

  const selectBrand = (brand: CompetitorBrand) => {
    const existing = brand === 'Outra' ? undefined : groups.find((group) => group.brand === brand);
    if (existing) {
      setActiveId(existing.id);
      setAnnouncement('Editando o estoque da marca ' + brand + '.');
      return;
    }
    const id = 'new-group-' + nextGroup.current++;
    const rowId = 'new-row-' + nextRow.current++;
    const group = { id, brand, otherBrand: '', rows: [emptyRow(rowId)] };
    pendingFocus.current = brand === 'Outra' ? id + '.otherBrand' : rowId + '.amperage';
    setGroups((current) => [...current, group]);
    setActiveId(id);
    setNoCompetition(false);
    setAnnouncement((brand === 'Outra' ? 'Outra marca' : brand)
      + ' adicionada. Preencha a primeira bateria.');
    clearErrors();
  };

  const updateGroup = (id: string, patch: Partial<CompetitorGroup>) => {
    setGroups((current) => current.map((group) => group.id === id ? { ...group, ...patch } : group));
    clearErrors();
  };

  const updateRow = (groupId: string, rowId: string, patch: Partial<CompetitorRow>) => {
    setGroups((current) => current.map((group) => group.id === groupId
      ? { ...group, rows: group.rows.map((row) => row.id === rowId ? { ...row, ...patch } : row) }
      : group));
    clearErrors();
  };

  const addRow = (groupId: string) => {
    const id = 'new-row-' + nextRow.current++;
    pendingFocus.current = id + '.amperage';
    setGroups((current) => current.map((group) => group.id === groupId
      ? { ...group, rows: [...group.rows, emptyRow(id)] } : group));
    setAnnouncement('Outra bateria adicionada para esta marca.');
    clearErrors();
  };

  const removeRow = (groupId: string, rowId: string) => {
    pendingFocus.current = 'add-row';
    setGroups((current) => current.map((group) => group.id === groupId
      ? { ...group, rows: group.rows.filter((row) => row.id !== rowId) } : group));
    setAnnouncement('Bateria removida da marca.');
    clearErrors();
  };

  const removeGroup = (id: string) => {
    const remaining = groups.filter((group) => group.id !== id);
    setGroups(remaining);
    setActiveId(remaining[0]?.id ?? null);
    setAnnouncement('Marca removida da coleta.');
    clearErrors();
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    const nextErrors: Record<string, string> = {};
    let firstInvalid: string | undefined;
    let invalidGroup: string | undefined;
    const addError = (key: string, message: string, groupId?: string) => {
      nextErrors[key] = message;
      firstInvalid ??= key;
      invalidGroup ??= groupId;
    };
    const competitorLines: CompetitorStockLine[] = [];

    if (!noCompetition && !groups.length) {
      addError('form', 'Selecione uma marca ou marque que não há estoque da concorrência.');
    }
    if (!noCompetition) {
      for (const group of groups) {
        const otherBrand = group.otherBrand.trim();
        if (group.brand === 'Outra' && !otherBrand) {
          addError(group.id + '.otherBrand', 'Digite o nome da marca.', group.id);
        }
        if (otherBrand.length > 80) {
          addError(group.id + '.otherBrand', 'Use no máximo 80 caracteres.', group.id);
        }
        if (!group.rows.length) {
          addError('form', 'Adicione ao menos uma bateria para cada marca.', group.id);
        }
        for (const row of group.rows) {
          const amperage = Number(row.amperage);
          const quantity = Number(row.quantity);
          const technology = row.technology.trim();
          if (!wholeNumber.test(row.amperage) || !Number.isSafeInteger(amperage)
            || amperage < 1 || amperage > 999) {
            addError(row.id + '.amperage', 'Informe a amperagem entre 1 e 999 Ah.', group.id);
          }
          if (!technology) {
            addError(row.id + '.technology', 'Informe a tecnologia.', group.id);
          }
          if (technology.length > 60) {
            addError(row.id + '.technology', 'Use no máximo 60 caracteres.', group.id);
          }
          if (!wholeNumber.test(row.quantity) || !Number.isSafeInteger(quantity)) {
            addError(row.id + '.quantity', 'Informe uma quantidade inteira, inclusive zero.', group.id);
          }
          if (wholeNumber.test(row.amperage) && Number.isSafeInteger(amperage)
            && amperage >= 1 && amperage <= 999 && technology
            && wholeNumber.test(row.quantity) && Number.isSafeInteger(quantity)) {
            competitorLines.push({
              brand: group.brand,
              amperage,
              technology,
              quantity,
              ...(group.brand === 'Outra' ? { otherBrand } : {}),
            });
          }
        }
      }
    }

    if (Object.keys(nextErrors).length) {
      if (invalidGroup) setActiveId(invalidGroup);
      setErrors(nextErrors);
      setFirstError(firstInvalid);
      setFocusAttempt((attempt) => attempt + 1);
      return;
    }

    const parsed = stockInputSchema.safeParse({
      heliarQuantity: draft.stock?.heliarQuantity ?? 0,
      mouraQuantity: competitorLines.filter((line) => line.brand === 'Moura')
        .reduce((sum, line) => sum + line.quantity, 0),
      ownLines: draft.stock?.ownLines ?? [],
      ...(draft.stock?.completedOwnBrands
        ? { completedOwnBrands: draft.stock.completedOwnBrands } : {}),
      competitorLines,
      ...(draft.stock?.observation ? { observation: draft.stock.observation } : {}),
    });
    if (!parsed.success) {
      setErrors({ form: 'Revise as informações de cada marca antes de salvar.' });
      setFirstError('form');
      setFocusAttempt((attempt) => attempt + 1);
      return;
    }
    setSaving(true);
    clearErrors();
    try {
      await onSave(parsed.data);
    } catch {
      setErrors({ form: 'Não foi possível salvar no aparelho. Os dados continuam nesta tela; tente novamente.' });
      setFirstError('form');
      setFocusAttempt((attempt) => attempt + 1);
    } finally {
      setSaving(false);
    }
  };

  return <section className="seller-stock-card seller-stock-collection"
    aria-labelledby="competitor-stock-title">
    <div className="seller-stock-heading">
      <div>
        <p className="seller-kicker">ESTOQUE DA CONCORRÊNCIA</p>
        <h2 id="competitor-stock-title" ref={titleRef} tabIndex={-1}>Marcas concorrentes</h2>
        <p className="seller-muted">Escolha a marca encontrada. Para cada bateria, informe amperagem, tecnologia e quantidade.</p>
      </div>
    </div>
    <form className="seller-stock-form" onSubmit={submit} noValidate>
      {groups.length === 0 && <label className="seller-stock-empty-choice">
        <input type="checkbox" checked={noCompetition}
          onChange={(event) => { setNoCompetition(event.target.checked); clearErrors(); }} />
        Não há estoque da concorrência neste PDV
      </label>}

      {!noCompetition && <>
        <div className="seller-stock-brand-picker">
          <h3>1. Selecione as marcas presentes</h3>
          <div className="seller-stock-brand-options">
            {COMPETITOR_STOCK_BRANDS.map((brand) => {
              const existing = groups.find((group) => group.brand === brand);
              return <button key={brand} className="seller-stock-brand-option" type="button"
                aria-pressed={Boolean(existing && activeId === existing.id)}
                onClick={() => selectBrand(brand)}>
                <span aria-hidden="true">{existing ? '✓' : '＋'}</span>{brand}
              </button>;
            })}
            <button className="seller-stock-brand-option" type="button"
              onClick={() => selectBrand('Outra')}><span aria-hidden="true">＋</span>Outra marca</button>
          </div>
        </div>

        {groups.length > 0 && <div className="seller-stock-added-brands">
          <h3>Marcas adicionadas</h3>
          <div className="seller-stock-added-list">
            {groups.map((group) => <button key={group.id} type="button"
              className="seller-stock-added-brand"
              aria-pressed={activeId === group.id}
              onClick={() => setActiveId(group.id)}>
              <span>{group.brand === 'Outra' ? group.otherBrand || 'Outra marca' : group.brand}</span>
              <small>{group.rows.length} {group.rows.length === 1 ? 'bateria' : 'baterias'}</small>
            </button>)}
          </div>
        </div>}

        {activeGroup && <fieldset className="seller-stock-brand-panel">
          <legend>2. Estoque {activeGroup.brand === 'Outra'
            ? activeGroup.otherBrand || 'de outra marca' : activeGroup.brand}</legend>
          {activeGroup.brand === 'Outra' && <div className="seller-stock-field">
            <label htmlFor={fieldId(activeGroup.id, 'otherBrand')}>Nome da marca</label>
            <input id={fieldId(activeGroup.id, 'otherBrand')} value={activeGroup.otherBrand}
              ref={registerControl(activeGroup.id + '.otherBrand')}
              maxLength={80} placeholder="Digite a marca encontrada"
              aria-invalid={Boolean(fieldError(activeGroup.id, 'otherBrand'))}
              aria-describedby={fieldError(activeGroup.id, 'otherBrand')
                ? fieldId(activeGroup.id, 'otherBrand') + '-error' : undefined}
              onChange={(event) => updateGroup(activeGroup.id, { otherBrand: event.target.value })} />
            {fieldError(activeGroup.id, 'otherBrand') && <p className="seller-field-error"
              id={fieldId(activeGroup.id, 'otherBrand') + '-error'}>
              {fieldError(activeGroup.id, 'otherBrand')}
            </p>}
          </div>}
          <div className="seller-stock-row-list">
            {activeGroup.rows.map((row, index) => <fieldset className="seller-stock-row" key={row.id}>
              <legend>Bateria {index + 1}</legend>
              <div className="seller-stock-row-fields seller-stock-competitor-fields">
                <div className="seller-stock-field">
                  <label htmlFor={fieldId(row.id, 'amperage')}>Amperagem (Ah)</label>
                  <input id={fieldId(row.id, 'amperage')} value={row.amperage}
                    ref={registerControl(row.id + '.amperage')}
                    inputMode="numeric" pattern="[0-9]*" placeholder="Ex.: 60"
                    aria-invalid={Boolean(fieldError(row.id, 'amperage'))}
                    aria-describedby={fieldError(row.id, 'amperage')
                      ? fieldId(row.id, 'amperage') + '-error' : undefined}
                    onChange={(event) => updateRow(activeGroup.id, row.id, { amperage: event.target.value })} />
                  {fieldError(row.id, 'amperage') && <p className="seller-field-error"
                    id={fieldId(row.id, 'amperage') + '-error'}>{fieldError(row.id, 'amperage')}</p>}
                </div>
                <div className="seller-stock-field">
                  <label htmlFor={fieldId(row.id, 'technology')}>Tecnologia</label>
                  <select id={fieldId(row.id, 'technology')} value={row.technology}
                    ref={registerControl(row.id + '.technology')}
                    aria-invalid={Boolean(fieldError(row.id, 'technology'))}
                    aria-describedby={fieldError(row.id, 'technology')
                      ? fieldId(row.id, 'technology') + '-error' : undefined}
                    onChange={(event) => updateRow(activeGroup.id, row.id, { technology: event.target.value })}>
                    <option value="">Selecione</option>
                    {row.technology && !COMPETITOR_STOCK_TECHNOLOGIES.some(
                      (technology) => technology === row.technology,
                    ) && <option value={row.technology}>{row.technology} (histórico)</option>}
                    {COMPETITOR_STOCK_TECHNOLOGIES.map((technology) =>
                      <option key={technology} value={technology}>{technology}</option>)}
                  </select>
                  {fieldError(row.id, 'technology') && <p className="seller-field-error"
                    id={fieldId(row.id, 'technology') + '-error'}>{fieldError(row.id, 'technology')}</p>}
                </div>
                <div className="seller-stock-field seller-stock-quantity">
                  <label htmlFor={fieldId(row.id, 'quantity')}>Quantidade</label>
                  <input id={fieldId(row.id, 'quantity')} value={row.quantity}
                    ref={registerControl(row.id + '.quantity')}
                    inputMode="numeric" pattern="[0-9]*" placeholder="0"
                    aria-invalid={Boolean(fieldError(row.id, 'quantity'))}
                    aria-describedby={fieldError(row.id, 'quantity')
                      ? fieldId(row.id, 'quantity') + '-error' : undefined}
                    onChange={(event) => updateRow(activeGroup.id, row.id, { quantity: event.target.value })} />
                  {fieldError(row.id, 'quantity') && <p className="seller-field-error"
                    id={fieldId(row.id, 'quantity') + '-error'}>{fieldError(row.id, 'quantity')}</p>}
                </div>
              </div>
              <button className="seller-stock-remove" type="button"
                aria-label={'Remover bateria ' + (index + 1) + ' da marca '
                  + (activeGroup.brand === 'Outra' ? activeGroup.otherBrand || 'Outra' : activeGroup.brand)}
                onClick={() => removeRow(activeGroup.id, row.id)}>Remover bateria</button>
            </fieldset>)}
          </div>
          <button className="seller-button seller-secondary seller-stock-add" type="button"
            ref={registerControl('add-row')}
            disabled={groups.reduce((sum, group) => sum + group.rows.length, 0) >= 200}
            onClick={() => addRow(activeGroup.id)}>
            <span aria-hidden="true">＋</span> Adicionar outra bateria
          </button>
          <button className="seller-stock-remove seller-stock-remove-brand" type="button"
            onClick={() => removeGroup(activeGroup.id)}>Remover esta marca</button>
        </fieldset>}
      </>}
      {errors.form && <p className="seller-form-error" role="alert" tabIndex={-1}
        ref={registerControl('form')}>{errors.form}</p>}
      <p className="seller-sr-only" role="status">{announcement}</p>
      <button className="seller-button seller-primary seller-stock-submit" disabled={saving} type="submit">
        {saving ? 'Salvando no aparelho…' : 'Salvar concorrência e continuar'}
      </button>
    </form>
  </section>;
}
