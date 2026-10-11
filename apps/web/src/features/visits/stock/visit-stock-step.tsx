'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { stockInputSchema, type LocalVisitDraft, type OwnStockLine, type StockInput } from '@cirne/contracts';
import {
  FALLBACK_UNIT_WEIGHT_KG,
  OWN_STOCK_BRANDS,
  STOCK_CATALOG_VERSION,
  ownLinesForBrand,
  ownProductByFactoryCode,
  ownProductItemsByBrand,
  stockWeightKg,
  type OwnStockBrand,
} from './own-product-catalog';

interface Props {
  draft: LocalVisitDraft;
  onSave: (values: StockInput, isLastBrand: boolean) => Promise<void>;
  onContinue: () => void;
}
type Quantities = Record<OwnStockBrand, Record<string, string>>;
type CustomModel = { id: string; name: string };
const wholeNumber = /^\d+$/u;

function initialQuantities(draft: LocalVisitDraft): Quantities {
  return Object.fromEntries(OWN_STOCK_BRANDS.map((brand) => [brand,
    Object.fromEntries(ownLinesForBrand(draft.stock?.ownLines, brand)
      .map((line) => [line.productCode ?? line.model, String(line.quantity)])),
  ])) as Quantities;
}

export function VisitStockStep({ draft, onSave, onContinue }: Props) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const nextCustomId = useRef(1);
  const [brand, setBrand] = useState<OwnStockBrand | null>(null);
  const [quantities, setQuantities] = useState(() => initialQuantities(draft));
  const [custom, setCustom] = useState<Record<OwnStockBrand, CustomModel[]>>(() =>
    Object.fromEntries(OWN_STOCK_BRANDS.map((item) => [item,
      ownLinesForBrand(draft.stock?.ownLines, item).filter((line) => !line.productCode)
        .map((line) => ({ id: line.model, name: line.model })),
    ])) as Record<OwnStockBrand, CustomModel[]>);
  const [search, setSearch] = useState('');
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [observation, setObservation] = useState(draft.stock?.observation ?? '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const completed = draft.stock?.completedOwnBrands ?? [];

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('brand');
    if (OWN_STOCK_BRANDS.some((item) => item === requested)) setBrand(requested as OwnStockBrand);
  }, []);
  useEffect(() => { titleRef.current?.focus(); }, [brand]);

  const selectBrand = (selected: OwnStockBrand | null) => {
    const url = new URL(window.location.href);
    if (selected) url.searchParams.set('brand', selected);
    else url.searchParams.delete('brand');
    window.history.replaceState({}, '', url);
    setBrand(selected);
    setSearch('');
    setConfirmEmpty(false);
    setError('');
  };
  const cancelBrand = () => {
    if (brand) {
      const saved = ownLinesForBrand(draft.stock?.ownLines, brand);
      setQuantities((current) => ({ ...current, [brand]: Object.fromEntries(
        saved.map((line) => [line.productCode ?? line.model, String(line.quantity)])) }));
      setCustom((current) => ({ ...current, [brand]: saved
        .filter((line) => !line.productCode)
        .map((line) => ({ id: line.model, name: line.model })) }));
      setObservation(draft.stock?.observation ?? '');
    }
    selectBrand(null);
  };
  const quantityFor = (item: OwnStockBrand, model: string) => quantities[item][model] ?? '0';
  const totalFor = (item: OwnStockBrand) => Object.values(quantities[item]).reduce((sum, value) =>
    sum + (wholeNumber.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : 0), 0);
  const total = OWN_STOCK_BRANDS.reduce((sum, item) => sum + totalFor(item), 0);
  const savedWeightFor = (item: OwnStockBrand) => stockWeightKg(draft.stock?.ownLines, item);
  const savedWeight = stockWeightKg(draft.stock?.ownLines);
  const changeQuantity = (item: OwnStockBrand, model: string, value: string) => {
    setQuantities((current) => ({ ...current, [item]: { ...current[item], [model]: value } }));
    setConfirmEmpty(false);
    setError('');
  };
  const adjustQuantity = (item: OwnStockBrand, model: string, delta: number) => {
    const current = Number(quantityFor(item, model));
    changeQuantity(item, model, String(Math.max(0, (Number.isSafeInteger(current) ? current : 0) + delta)));
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!brand || saving) return;
    const entries = Object.entries(quantities[brand]);
    if (entries.some(([, value]) => !wholeNumber.test(value) || !Number.isSafeInteger(Number(value)))) {
      setError('Corrija as quantidades: use números inteiros a partir de zero.');
      return;
    }
    if (custom[brand].some((item) => !item.name.trim() && Number(quantities[brand][item.id] ?? 0) > 0)) {
      setError('Digite o nome do modelo adicionado em “Outra”.');
      return;
    }
    const currentLines: OwnStockLine[] = entries.filter(([key, value]) =>
      !custom[brand].some((item) => item.id === key) && Number(value) > 0)
      .map(([productCode, value]) => {
        const product = ownProductByFactoryCode.get(productCode);
        if (!product || product.brand !== brand) return {
          brand, model: productCode, quantity: Number(value), unitWeightKg: FALLBACK_UNIT_WEIGHT_KG,
          catalogVersion: STOCK_CATALOG_VERSION, weightSource: 'fallback_15kg' as const,
        };
        return {
          brand,
          model: product.model,
          quantity: Number(value),
          productCode: product.factoryCode,
          sku: product.sku,
          unitWeightKg: product.unitWeightKg,
          catalogVersion: STOCK_CATALOG_VERSION,
          weightSource: product.weightSource,
        };
      });
    for (const item of custom[brand]) {
      const quantity = Number(quantities[brand][item.id] ?? 0);
      if (quantity > 0) currentLines.push({
        brand, model: item.name.trim(), quantity, unitWeightKg: FALLBACK_UNIT_WEIGHT_KG,
        catalogVersion: STOCK_CATALOG_VERSION, weightSource: 'fallback_15kg',
      });
    }
    if (new Set(currentLines.map((line) => line.model.toLocaleLowerCase('pt-BR'))).size !== currentLines.length) {
      setError('Há modelos repetidos nesta marca. Revise os nomes antes de salvar.');
      return;
    }
    if (!currentLines.length && !confirmEmpty) {
      setError('Marque a confirmação de estoque zerado para salvar esta marca.');
      return;
    }
    const ownLines = [...(draft.stock?.ownLines ?? []).filter((line) => line.brand !== brand), ...currentLines];
    if (ownLines.length > 200) { setError('O limite da coleta é de 200 modelos.'); return; }
    const completedOwnBrands = OWN_STOCK_BRANDS.filter((item) => item === brand || completed.includes(item));
    const parsed = stockInputSchema.safeParse({
      heliarQuantity: ownLines.filter((line) => line.brand === 'Heliar').reduce((sum, line) => sum + line.quantity, 0),
      mouraQuantity: draft.stock?.mouraQuantity ?? 0,
      ownLines,
      ...(draft.stock?.competitorLines !== undefined ? { competitorLines: draft.stock.competitorLines } : {}),
      completedOwnBrands,
      ...(observation.trim() ? { observation } : {}),
    });
    if (!parsed.success) { setError('Revise os modelos e quantidades antes de salvar.'); return; }
    setSaving(true);
    try { await onSave(parsed.data, completedOwnBrands.length === OWN_STOCK_BRANDS.length); selectBrand(null); }
    catch { setError('Não foi possível salvar no aparelho. Os dados continuam nesta tela; tente novamente.'); }
    finally { setSaving(false); }
  };

  if (!brand) return <section className="seller-stock-card seller-stock-collection" aria-labelledby="stock-title">
    <p className="seller-kicker">COLETA DE ESTOQUE</p>
    <h2 id="stock-title" ref={titleRef} tabIndex={-1}>Estoque do cliente</h2>
    <p className="seller-muted">Toque em uma marca para registrar os modelos encontrados no PDV.</p>
    <div className="seller-stock-total"><span>Total geral</span><strong>{total} un. · {savedWeight.toLocaleString('pt-BR')} kg</strong></div>
    <div className="seller-stock-overview">{OWN_STOCK_BRANDS.map((item) => <button
      className="seller-stock-brand-card" type="button" key={item} onClick={() => selectBrand(item)}
      aria-label={`${item}: ${totalFor(item)} unidades. Abrir modelos`}>
      <span className="seller-stock-brand-avatar" aria-hidden="true">{item[0]}</span>
      <span className="seller-stock-brand-copy"><strong>{item}</strong><small>{completed.includes(item)
        ? totalFor(item) === 0 ? 'Concluída · sem estoque' : 'Coleta salva'
        : 'Pendente · toque para coletar'}</small></span>
      <strong className="seller-stock-brand-count">{totalFor(item)} <small>· {savedWeightFor(item).toLocaleString('pt-BR')} kg</small></strong>
      <span className="seller-stock-brand-chevron" aria-hidden="true">›</span>
    </button>)}</div>
    <p className="seller-stock-progress-text">{completed.length} de {OWN_STOCK_BRANDS.length} marcas concluídas</p>
    <button className="seller-button seller-primary seller-stock-submit" type="button"
      disabled={completed.length < OWN_STOCK_BRANDS.length} onClick={onContinue}>
      Continuar para estoque da concorrência
    </button>
  </section>;

  const catalog = ownProductItemsByBrand[brand];
  const normalizedSearch = search.toLocaleLowerCase('pt-BR');
  const visible = catalog.filter((item) => `${item.model} ${item.description} ${item.factoryCode} ${item.sku}`
    .toLocaleLowerCase('pt-BR').includes(normalizedSearch));
  const brandTotal = totalFor(brand);
  return <section className="seller-stock-card seller-stock-collection" aria-labelledby="stock-title">
    <button className="seller-stock-back" type="button" onClick={cancelBrand}>‹ Todas as marcas</button>
    <div className="seller-stock-detail-heading"><div><p className="seller-kicker">ESTOQUE PRÓPRIO</p>
      <h2 id="stock-title" ref={titleRef} tabIndex={-1}>{brand}</h2>
      <p className="seller-muted">Ajuste a quantidade de cada modelo encontrado.</p></div>
      <strong>{brandTotal} <small>un.</small></strong></div>
    <form className="seller-stock-form" onSubmit={submit} noValidate>
      <label className="seller-stock-search-label" htmlFor="own-stock-search">Buscar modelo</label>
      <input id="own-stock-search" className="seller-stock-search" type="search" value={search}
        placeholder="Nome ou código do modelo" onChange={(event) => setSearch(event.target.value)} />
      <p className="seller-stock-list-count">{visible.length} modelo(s) da lista</p>
      <div className="seller-stock-model-list">{visible.map((item) => <div className="seller-stock-model-row" key={item.id}>
        <label htmlFor={'quantity-' + item.factoryCode}>{item.model}<small>{item.factoryCode} · {item.unitWeightKg} kg/un.</small></label>
        <div className="seller-stock-stepper">
          <button type="button" aria-label={'Diminuir ' + item.model} disabled={Number(quantityFor(brand, item.factoryCode)) <= 0}
            onClick={() => adjustQuantity(brand, item.factoryCode, -1)}>−</button>
          <input id={'quantity-' + item.factoryCode} aria-label={'Quantidade de ' + item.model + ' ' + item.factoryCode}
            inputMode="numeric" pattern="[0-9]*" value={quantityFor(brand, item.factoryCode)}
            onChange={(event) => changeQuantity(brand, item.factoryCode, event.target.value)} />
          <button type="button" aria-label={'Aumentar ' + item.model}
            onClick={() => adjustQuantity(brand, item.factoryCode, 1)}>+</button>
        </div>
      </div>)}{!visible.length && <p className="seller-muted">Nenhum modelo encontrado. Use “Outra” se não estiver cadastrado.</p>}</div>
      <div className="seller-stock-other-list">{custom[brand].map((item) => <div className="seller-stock-other-row" key={item.id}>
        <label htmlFor={'other-name-' + item.id}>Outro modelo</label>
        <input id={'other-name-' + item.id} maxLength={120} placeholder="Nome do modelo" value={item.name}
          onChange={(event) => setCustom((current) => ({ ...current, [brand]: current[brand].map((row) =>
            row.id === item.id ? { ...row, name: event.target.value } : row) }))} />
        <div className="seller-stock-stepper">
          <button type="button" aria-label={'Diminuir outro modelo ' + item.id}
            disabled={Number(quantityFor(brand, item.id)) <= 0} onClick={() => adjustQuantity(brand, item.id, -1)}>−</button>
          <input aria-label={'Quantidade de outro modelo ' + item.id} inputMode="numeric" pattern="[0-9]*"
            value={quantityFor(brand, item.id)} onChange={(event) => changeQuantity(brand, item.id, event.target.value)} />
          <button type="button" aria-label={'Aumentar outro modelo ' + item.id}
            onClick={() => adjustQuantity(brand, item.id, 1)}>+</button>
        </div>
        <button className="seller-stock-remove" type="button" onClick={() => {
          setCustom((current) => ({ ...current, [brand]: current[brand].filter((row) => row.id !== item.id) }));
          setQuantities((current) => { const next = { ...current[brand] }; delete next[item.id]; return { ...current, [brand]: next }; });
        }}>Remover</button>
      </div>)}</div>
      <button className="seller-button seller-secondary seller-stock-add" type="button" onClick={() => {
        const id = 'custom-' + nextCustomId.current++;
        setCustom((current) => ({ ...current, [brand]: [...current[brand], { id, name: '' }] }));
      }}>+ Outra — digitar modelo</button>
      {brandTotal === 0 && <label className="seller-stock-empty-choice"><input type="checkbox" checked={confirmEmpty}
        onChange={(event) => setConfirmEmpty(event.target.checked)} />
        Confirmo que não há estoque de {brand} neste PDV</label>}
      <div className="seller-stock-field seller-stock-note"><label htmlFor="stock-observation">Observação da coleta (opcional)</label>
        <textarea id="stock-observation" maxLength={500} value={observation}
          onChange={(event) => setObservation(event.target.value)} /></div>
      {error && <p className="seller-form-error" role="alert">{error}</p>}
      <button className="seller-button seller-primary seller-stock-submit" disabled={saving} type="submit">
        {saving ? 'Salvando no aparelho…' : 'Salvar ' + brand}</button>
    </form>
  </section>;
}
