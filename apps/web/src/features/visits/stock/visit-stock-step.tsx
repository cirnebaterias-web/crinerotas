'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { stockInputSchema, type LocalVisitDraft, type StockInput } from '@cirne/contracts';

interface VisitStockStepProps {
  draft: LocalVisitDraft;
  onSave: (values: StockInput) => Promise<void>;
}

function parseQuantity(value: string) {
  if (!/^\d+$/.test(value)) return undefined;
  const quantity = Number(value);
  return Number.isSafeInteger(quantity) ? quantity : undefined;
}

export function VisitStockStep({ draft, onSave }: VisitStockStepProps) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const heliarRef = useRef<HTMLInputElement>(null);
  const mouraRef = useRef<HTMLInputElement>(null);
  const [heliar, setHeliar] = useState(draft.stock?.heliarQuantity.toString() ?? '');
  const [moura, setMoura] = useState(draft.stock?.mouraQuantity.toString() ?? '');
  const [observation, setObservation] = useState(draft.stock?.observation ?? '');
  const [errors, setErrors] = useState<{ heliar?: string; moura?: string; form?: string }>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => { titleRef.current?.focus(); }, []);
  useEffect(() => {
    if (errors.heliar) heliarRef.current?.focus();
    else if (errors.moura) mouraRef.current?.focus();
  }, [errors]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextErrors: typeof errors = {};
    const heliarQuantity = parseQuantity(heliar);
    const mouraQuantity = parseQuantity(moura);
    if (heliarQuantity === undefined) nextErrors.heliar = 'Informe um número inteiro igual ou maior que zero.';
    if (mouraQuantity === undefined) nextErrors.moura = 'Informe um número inteiro igual ou maior que zero.';
    if (nextErrors.heliar || nextErrors.moura) {
      setErrors(nextErrors);
      return;
    }
    const parsed = stockInputSchema.safeParse({
      heliarQuantity,
      mouraQuantity,
      ...(observation.trim() ? { observation } : {}),
    });
    if (!parsed.success) {
      setErrors({ form: 'Revise os valores informados antes de salvar.' });
      return;
    }
    setSaving(true);
    setErrors({});
    try {
      await onSave(parsed.data);
    } catch {
      setErrors({ form: 'Não foi possível salvar no aparelho. Os valores continuam nesta tela; tente novamente.' });
    } finally {
      setSaving(false);
    }
  };

  return <section className="seller-stock-card" aria-labelledby="stock-title">
    {draft.stock && <p className="seller-kicker">ETAPA 1 DE 4</p>}
    <h2 id="stock-title" ref={titleRef} tabIndex={-1}>Estoque observado</h2>
    <p className="seller-muted">Informe as quantidades encontradas no cliente. Zero é um valor válido.</p>
    <form className="seller-stock-form" onSubmit={submit} noValidate>
      <label htmlFor="stock-heliar">Quantidade observada — Heliar</label>
      <input
        id="stock-heliar"
        ref={heliarRef}
        name="heliarQuantity"
        type="number"
        inputMode="numeric"
        min="0"
        step="1"
        required
        value={heliar}
        aria-invalid={Boolean(errors.heliar)}
        aria-describedby={errors.heliar ? 'stock-heliar-error' : undefined}
        onChange={(event) => setHeliar(event.target.value)}
      />
      {errors.heliar && <p className="seller-field-error" id="stock-heliar-error">{errors.heliar}</p>}

      <label htmlFor="stock-moura">Quantidade observada — Moura</label>
      <input
        id="stock-moura"
        ref={mouraRef}
        name="mouraQuantity"
        type="number"
        inputMode="numeric"
        min="0"
        step="1"
        required
        value={moura}
        aria-invalid={Boolean(errors.moura)}
        aria-describedby={errors.moura ? 'stock-moura-error' : undefined}
        onChange={(event) => setMoura(event.target.value)}
      />
      {errors.moura && <p className="seller-field-error" id="stock-moura-error">{errors.moura}</p>}

      <label htmlFor="stock-observation">Observação (opcional)</label>
      <textarea
        id="stock-observation"
        name="observation"
        maxLength={500}
        value={observation}
        onChange={(event) => setObservation(event.target.value)}
      />
      <p className="seller-field-hint">{observation.length}/500 caracteres</p>
      {errors.form && <p className="seller-form-error" role="alert">{errors.form}</p>}
      <button className="seller-button seller-primary seller-stock-submit" disabled={saving} type="submit">
        {saving ? 'Salvando no aparelho…' : 'Salvar estoque e continuar'}
      </button>
    </form>
  </section>;
}
