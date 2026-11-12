'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { visitSalesInputSchema, type LocalVisitDraft, type VisitSalesInput } from '@cirne/contracts';

interface Props {
  draft: LocalVisitDraft;
  onSave: (values: VisitSalesInput, expectedVersion: number) => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
}

const fields = [
  { name: 'heliarQuantity', label: 'Heliar' },
  { name: 'americaQuantity', label: 'América' },
  { name: 'stradaDurexQuantity', label: 'Strada/Durex' },
] as const;
type FieldName = typeof fields[number]['name'];
type Quantities = Record<FieldName, string>;

export function VisitSalesStep({ draft, onSave, onDirtyChange }: Props) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const inputRefs = useRef<Partial<Record<FieldName, HTMLInputElement>>>({});
  const [loadedVersion] = useState(() => draft.sales?.version ?? 0);
  const [quantities, setQuantities] = useState<Quantities>(() => ({
    heliarQuantity: draft.sales ? String(draft.sales.heliarQuantity) : '',
    americaQuantity: draft.sales ? String(draft.sales.americaQuantity) : '',
    stradaDurexQuantity: draft.sales ? String(draft.sales.stradaDurexQuantity) : '',
  }));
  const [errors, setErrors] = useState<Partial<Record<FieldName, string>>>({});
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [versionConflict, setVersionConflict] = useState(false);
  const stale = !saving && (versionConflict || (draft.sales?.version ?? 0) !== loadedVersion);

  useEffect(() => { titleRef.current?.focus(); }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving || stale) return;
    const nextErrors: Partial<Record<FieldName, string>> = {};
    for (const { name } of fields) {
      if (!/^\d+$/u.test(quantities[name])) nextErrors[name] = 'Informe uma quantidade inteira a partir de zero.';
    }
    const values = Object.fromEntries(fields.map(({ name }) => [name, Number(quantities[name])]));
    const parsed = visitSalesInputSchema.safeParse(values);
    if (!parsed.success) for (const issue of parsed.error.issues) {
      const field = fields.find(({ name }) => name === issue.path[0]);
      if (field) nextErrors[field.name] = 'Informe uma quantidade inteira entre 0 e 2147483647.';
    }
    setErrors(nextErrors);
    setError('');
    const firstInvalid = fields.find(({ name }) => nextErrors[name]);
    if (firstInvalid || !parsed.success) {
      if (firstInvalid) inputRefs.current[firstInvalid.name]?.focus();
      return;
    }
    setSaving(true);
    try {
      await onSave(parsed.data, loadedVersion);
      onDirtyChange?.(false);
    } catch (failure) {
      if (failure instanceof Error && 'code' in failure && failure.code === 'VERSION_CONFLICT') setVersionConflict(true);
      else setError('Não foi possível salvar no aparelho. Os dados continuam nesta tela; tente novamente.');
    } finally { setSaving(false); }
  };

  return <section className="seller-stock-card seller-stock-collection" aria-labelledby="sales-title">
    <p className="seller-kicker">INFORME DE VENDA</p>
    <h2 id="sales-title" ref={titleRef} tabIndex={-1}>Informe de venda na visita</h2>
    <p className="seller-muted" id="sales-instructions">Informe quantas baterias vendeu nesta visita. Preencha 0 quando não houve venda da marca.</p>
    {stale && <p className="seller-form-error" role="alert">O informe foi atualizado em outra sessão. Seus campos continuam nesta tela. Volte às tarefas e reabra o informe para revisar os valores atuais antes de salvar.</p>}
    <form className="seller-stock-form" onSubmit={submit} noValidate aria-busy={saving}>
      {fields.map(({ name, label }) => <div className="seller-stock-field" key={name}>
        <label htmlFor={`sales-${name}`}>{label}</label>
        <input id={`sales-${name}`} ref={(element) => { if (element) inputRefs.current[name] = element; }}
          type="text" inputMode="numeric" pattern="[0-9]*" required disabled={saving}
          aria-invalid={Boolean(errors[name])} aria-describedby={`sales-instructions${errors[name] ? ` sales-${name}-error` : ''}`}
          value={quantities[name]} onChange={(event) => {
            setQuantities((current) => ({ ...current, [name]: event.target.value }));
            setErrors((current) => ({ ...current, [name]: undefined }));
            setError(''); onDirtyChange?.(true);
          }} />
        {errors[name] && <p className="seller-form-error" id={`sales-${name}-error`} role="alert">{errors[name]}</p>}
      </div>)}
      {error && <p className="seller-form-error" role="alert">{error}</p>}
      <button className="seller-button seller-primary seller-stock-submit" disabled={saving || stale} type="submit">
        {saving ? 'Salvando no aparelho…' : 'Salvar informe de venda'}</button>
    </form>
  </section>;
}
