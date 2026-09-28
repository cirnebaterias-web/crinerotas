'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { stockInputSchema, type LocalVisitDraft, type OwnStockLine, type StockInput } from '@cirne/contracts';
import { OWN_STOCK_BRANDS, ownProductCatalog, ownLinesForBrand, type OwnStockBrand } from './own-product-catalog';

interface VisitStockStepProps { draft: LocalVisitDraft; onSave: (values: StockInput) => Promise<void>; }
type Row = { model: string; quantity: string };
const emptyRow = (): Row => ({ model: '', quantity: '' });

export function VisitStockStep({ draft, onSave }: VisitStockStepProps) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [brandIndex, setBrandIndex] = useState(0);
  const [rowsByBrand, setRowsByBrand] = useState<Record<string, Row[]>>(() => Object.fromEntries(
    OWN_STOCK_BRANDS.map((item) => { const rows = ownLinesForBrand(draft.stock?.ownLines, item).map((line) => ({ model: line.model, quantity: String(line.quantity) })); return [item, rows.length ? rows : [emptyRow()]]; }),
  ) as Record<string, Row[]>);
  const [observation, setObservation] = useState(draft.stock?.observation ?? '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const brand = OWN_STOCK_BRANDS[brandIndex] ?? OWN_STOCK_BRANDS[0];
  useEffect(() => { titleRef.current?.focus(); }, [brandIndex]);
  const updateRow = (index: number, patch: Partial<Row>) => setRowsByBrand((current) => ({ ...current, [brand]: (current[brand] ?? []).map((row, i) => i === index ? { ...row, ...patch } : row) }));
  const parseLines = (): OwnStockLine[] => OWN_STOCK_BRANDS.flatMap((item) => (rowsByBrand[item] ?? []).flatMap((row) => {
    const quantity = Number(row.quantity);
    if (!row.model && !row.quantity) return [];
    if (!row.model || !Number.isSafeInteger(quantity) || quantity < 0) throw new Error('Informe modelo e quantidade em todas as linhas preenchidas.');
    return [{ brand: item, model: row.model, quantity }];
  }));
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      const ownLines = parseLines();
      if (brandIndex < OWN_STOCK_BRANDS.length - 1) { setBrandIndex((value) => value + 1); setError(''); return; }
      const heliarQuantity = ownLines.filter((line) => line.brand === 'Heliar').reduce((sum, line) => sum + line.quantity, 0);
      const parsed = stockInputSchema.parse({ heliarQuantity, mouraQuantity: draft.stock?.mouraQuantity ?? 0, ownLines, ...(draft.stock?.competitorLines ? { competitorLines: draft.stock.competitorLines } : {}), ...(observation.trim() ? { observation } : {}) });
      setSaving(true); setError(''); await onSave(parsed);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Revise os valores antes de salvar.'); } finally { setSaving(false); }
  };
  return <section className="seller-stock-card" aria-labelledby="stock-title">
    <p className="seller-kicker">ESTOQUE PRÓPRIO · {brandIndex + 1} DE {OWN_STOCK_BRANDS.length}</p>
    <h2 id="stock-title" ref={titleRef} tabIndex={-1}>Estoque {brand}</h2>
    <p className="seller-muted">Adicione cada modelo encontrado. Use “Outra” quando não estiver cadastrado.</p>
    <form className="seller-stock-form" onSubmit={submit} noValidate>
      {(rowsByBrand[brand] ?? []).map((row, index) => <div className="seller-stock-row" key={`${brand}-${index}`}>
        <label htmlFor={`stock-model-${index}`}>Modelo</label>
        <select id={`stock-model-${index}`} value={row.model} onChange={(event) => updateRow(index, { model: event.target.value })}><option value="">Selecione</option>{ownProductCatalog[brand as OwnStockBrand].map((model) => <option key={model} value={model}>{model}</option>)}<option value="Outra">Outra</option></select>
        {(row.model === 'Outra' || row.model.startsWith('Outra:')) && <input aria-label="Nome do modelo" placeholder="Digite o modelo" value={row.model.replace(/^Outra:\s*/u, '').replace(/^Outra$/u, '')} onChange={(event) => updateRow(index, { model: event.target.value ? `Outra: ${event.target.value}` : 'Outra' })} />}
        <label htmlFor={`stock-qty-${index}`}>Quantidade</label><input id={`stock-qty-${index}`} type="number" min="0" step="1" inputMode="numeric" value={row.quantity} onChange={(event) => updateRow(index, { quantity: event.target.value })} />
      </div>)}
      <button className="seller-button seller-secondary" type="button" onClick={() => setRowsByBrand((current) => ({ ...current, [brand]: [...(current[brand] ?? []), emptyRow()] }))}>+ Adicionar outro modelo</button>
      {brandIndex === OWN_STOCK_BRANDS.length - 1 && <><label htmlFor="stock-observation">Observação (opcional)</label><textarea id="stock-observation" maxLength={500} value={observation} onChange={(event) => setObservation(event.target.value)} /></>}
      {error && <p className="seller-form-error" role="alert">{error}</p>}
      <button className="seller-button seller-primary seller-stock-submit" disabled={saving} type="submit">{saving ? 'Salvando no aparelho…' : brandIndex < OWN_STOCK_BRANDS.length - 1 ? 'Próxima marca' : 'Salvar estoque próprio'}</button>
    </form>
  </section>;
}
