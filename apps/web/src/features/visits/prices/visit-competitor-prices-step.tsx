'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  competitorPricesInputSchema,
  type CompetitorPricesInput,
  type LocalCompetitorPriceParameterSet,
  type LocalVisitDraft,
} from '@cirne/contracts';
import {
  OWN_STOCK_BRANDS,
  ownLinesForBrand,
  ownProductItemsByBrand,
  type OwnStockBrand,
} from '../stock/own-product-catalog';

interface Props {
  draft: LocalVisitDraft;
  parameters: LocalCompetitorPriceParameterSet | null;
  onSave: (values: CompetitorPricesInput) => Promise<void>;
}

type Availability = CompetitorPricesInput['availability'];
type Field = 'modelOrAmperage' | 'technologyId' | 'priceBrl' | 'conditionId' | 'observation';
type RowSource = 'saved' | 'stock' | 'catalog' | 'manual';
type Row = { rowId: string; modelOrAmperage: string; technologyId: string; priceBrl: string;
  conditionId: string; observation: string; source: RowSource; productCode?: string };
type Group = { id: string; competitorId: string; rows: Row[] };
type Screen = 'own-overview' | 'own-detail' | 'competitors';

const moneyPattern = /^\d+(?:\.\d+)?$/;
const ownBrands = new Set<string>(OWN_STOCK_BRANDS);
const normalizeMoney = (value: string) => /^\d+,\d+$/.test(value) ? value.replace(',', '.') : value;
const key = (rowId: string, field: Field) => `${rowId}.${field}`;
const emptyRow = (rowId: string, source: RowSource = 'manual'): Row => ({ rowId,
  modelOrAmperage: '', technologyId: '', priceBrl: '', conditionId: '', observation: '', source });

export function findCatalogPriceRow<T extends { productCode?: string; modelOrAmperage: string }>(
  rows: T[] | undefined,
  productCode: string,
  model: string,
): T | undefined {
  return rows?.find((row) => row.productCode === productCode)
    ?? rows?.find((row) => !row.productCode
      && row.modelOrAmperage.toLocaleLowerCase('pt-BR') === model.toLocaleLowerCase('pt-BR'));
}

function initialGroups(draft: LocalVisitDraft): Group[] {
  if (draft.prices?.availability !== 'available') return [];
  const groups = new Map<string, Group>();
  draft.prices.quotations.forEach((quotation, index) => {
    const group = groups.get(quotation.competitorId) ?? {
      id: `saved-brand-${groups.size + 1}`, competitorId: quotation.competitorId, rows: [],
    };
    group.rows.push({
      rowId: `saved-${index + 1}`, modelOrAmperage: quotation.modelOrAmperage,
      technologyId: quotation.technologyId, priceBrl: quotation.priceBrl,
      conditionId: quotation.conditionId, observation: quotation.observation ?? '', source: 'saved',
      productCode: quotation.productCode,
    });
    groups.set(quotation.competitorId, group);
  });
  return [...groups.values()];
}

export function VisitCompetitorPricesStep({ draft, parameters, onSave }: Props) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const refs = useRef<Record<string, HTMLElement | null>>({});
  const pendingFocus = useRef<string | null>(null);
  const startingGroups = useMemo(() => initialGroups(draft), [draft]);
  const nextGroup = useRef(startingGroups.length + 1);
  const nextRow = useRef(startingGroups.reduce((sum, group) => sum + group.rows.length, 0) + 1);
  const configured = Boolean(parameters?.values.competitors.length
    && parameters.values.technologies.length && parameters.values.conditions.length);
  const unavailableConfigured = Boolean(parameters?.values.unavailableReasons.length);
  const initialAvailability = draft.prices?.availability
    ?? (configured ? 'available' : unavailableConfigured ? 'unavailable' : 'available');
  const [availability, setAvailability] = useState<Availability>(initialAvailability);
  const [groups, setGroups] = useState<Group[]>(startingGroups);
  const [screen, setScreen] = useState<Screen>('own-overview');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeOwnBrand, setActiveOwnBrand] = useState<OwnStockBrand | null>(null);
  const [completedOwnBrands, setCompletedOwnBrands] = useState<OwnStockBrand[]>([]);
  const [search, setSearch] = useState('');
  const [unavailableReasonId, setUnavailableReasonId] = useState(
    draft.prices?.availability === 'unavailable' ? draft.prices.unavailableReasonId : '',
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [firstError, setFirstError] = useState<string>();
  const [focusAttempt, setFocusAttempt] = useState(0);
  const [announcement, setAnnouncement] = useState('');
  const [saving, setSaving] = useState(false);

  const catalog = parameters?.values.competitors ?? [];
  const ownCatalog = catalog.filter(({ label }) => ownBrands.has(label));
  const competitorCatalog = catalog.filter(({ label }) => !ownBrands.has(label));
  const activeGroup = groups.find(({ id }) => id === activeId);
  const totalRows = groups.reduce((sum, group) => sum + group.rows.length, 0);
  const brandLabel = (id: string) => catalog.find((brand) => brand.id === id)?.label ?? 'Marca histórica';
  const ownParameter = (brand: OwnStockBrand) => ownCatalog.find(({ label }) => label === brand);
  const clearErrors = () => { setErrors({}); setFirstError(undefined); };
  const register = (controlKey: string) => (element: HTMLElement | null) => { refs.current[controlKey] = element; };
  const fieldId = (rowId: string, field: Field) => `price-${rowId}-${field}`;
  const fieldError = (rowId: string, field: Field) => errors[key(rowId, field)];
  const defaultConditionId = parameters?.values.conditions[0]?.id ?? '';
  const technologyIdFor = (model: string) => {
    const normalized = model.toLocaleLowerCase('pt-BR');
    const expected = normalized.includes('agm') ? 'agm' : normalized.includes('efb') ? 'efb' : 'sli';
    return parameters?.values.technologies.find(({ code, label }) =>
      `${code} ${label}`.toLocaleLowerCase('pt-BR').includes(expected))?.id
      ?? parameters?.values.technologies[0]?.id ?? '';
  };

  useEffect(() => { titleRef.current?.focus(); }, [screen, activeOwnBrand]);
  useEffect(() => { if (firstError) refs.current[firstError]?.focus(); }, [firstError, focusAttempt, activeId]);
  useEffect(() => {
    if (!pendingFocus.current) return;
    refs.current[pendingFocus.current]?.focus();
    pendingFocus.current = null;
  }, [groups, activeId]);

  const updateRow = (groupId: string, rowId: string, field: Field, value: string) => {
    setGroups((current) => current.map((group) => group.id === groupId
      ? { ...group, rows: group.rows.map((row) => row.rowId === rowId ? { ...row, [field]: value } : row) }
      : group));
    clearErrors();
  };

  const openOwnBrand = (brand: OwnStockBrand) => {
    const parameter = ownParameter(brand);
    if (!parameter) return;
    const existing = groups.find(({ competitorId }) => competitorId === parameter.id);
    const stockLines = ownLinesForBrand(draft.stock?.ownLines, brand)
      .filter(({ quantity, productCode }) => quantity > 0 && !productCode);
    if (existing) {
      const existingModels = new Set(existing.rows.map(({ modelOrAmperage }) => modelOrAmperage.toLocaleLowerCase('pt-BR')));
      const availableSlots = Math.max(0, 25 - totalRows);
      const missing = stockLines.filter(({ model }) => !existingModels.has(model.toLocaleLowerCase('pt-BR')))
        .slice(0, availableSlots)
        .map((line) => ({ ...emptyRow(`new-row-${nextRow.current++}`, 'stock'),
          modelOrAmperage: line.model, productCode: line.productCode,
          technologyId: technologyIdFor(line.model), conditionId: defaultConditionId }));
      if (missing.length) setGroups((current) => current.map((group) => group.id === existing.id
        ? { ...group, rows: [...group.rows, ...missing] } : group));
      setActiveId(existing.id);
    } else {
      const id = `new-brand-${nextGroup.current++}`;
      const availableSlots = Math.max(0, 25 - totalRows);
      const rows = stockLines.slice(0, availableSlots).map((line) => ({ ...emptyRow(`new-row-${nextRow.current++}`, 'stock'),
        modelOrAmperage: line.model, productCode: line.productCode,
        technologyId: technologyIdFor(line.model), conditionId: defaultConditionId }));
      setGroups((current) => [...current, { id, competitorId: parameter.id, rows }]);
      setActiveId(id);
    }
    setActiveOwnBrand(brand); setScreen('own-detail'); setSearch(''); clearErrors();
  };

  const ownGroupFor = (brand: OwnStockBrand) => {
    const parameter = ownParameter(brand);
    return parameter ? groups.find(({ competitorId }) => competitorId === parameter.id) : undefined;
  };
  const rowForProduct = (group: Group | undefined, productCode: string, model: string) =>
    findCatalogPriceRow(group?.rows, productCode, model);
  const setCatalogPrice = (group: Group, productCode: string, model: string, value: string) => {
    const existing = rowForProduct(group, productCode, model);
    if (existing) {
      if (!value && existing.source !== 'manual') {
        setGroups((current) => current.map((item) => item.id === group.id
          ? { ...item, rows: item.rows.filter(({ rowId }) => rowId !== existing.rowId) } : item));
      } else updateRow(group.id, existing.rowId, 'priceBrl', value);
      return;
    }
    if (!value || totalRows >= 25) return;
    const rowId = `new-row-${nextRow.current++}`;
    const row = { ...emptyRow(rowId, 'catalog'), productCode, modelOrAmperage: model, priceBrl: value,
      technologyId: technologyIdFor(model), conditionId: defaultConditionId };
    setGroups((current) => current.map((item) => item.id === group.id
      ? { ...item, rows: [...item.rows, row] } : item));
    clearErrors();
  };

  const selectCompetitorBrand = (competitorId: string) => {
    const existing = groups.find((group) => group.competitorId === competitorId);
    if (existing) { setActiveId(existing.id); clearErrors(); return; }
    const id = `new-brand-${nextGroup.current++}`;
    const rowId = `new-row-${nextRow.current++}`;
    pendingFocus.current = key(rowId, 'modelOrAmperage');
    setGroups((current) => [...current, { id, competitorId, rows: [emptyRow(rowId)] }]);
    setActiveId(id);
    setAnnouncement(`${brandLabel(competitorId)} adicionada. Preencha a primeira bateria.`); clearErrors();
  };

  const addManualRow = (groupId: string) => {
    if (totalRows >= 25) return;
    const rowId = `new-row-${nextRow.current++}`;
    pendingFocus.current = key(rowId, 'modelOrAmperage');
    setGroups((current) => current.map((group) => group.id === groupId
      ? { ...group, rows: [...group.rows, emptyRow(rowId)] } : group));
    setAnnouncement('Outra bateria adicionada para esta marca.'); clearErrors();
  };
  const removeRow = (groupId: string, rowId: string) => {
    pendingFocus.current = 'add-row';
    setGroups((current) => current.map((group) => group.id === groupId
      ? { ...group, rows: group.rows.filter((row) => row.rowId !== rowId) } : group));
    setAnnouncement('Bateria removida da pesquisa de preços.'); clearErrors();
  };
  const removeGroup = (groupId: string) => {
    setGroups((current) => current.filter(({ id }) => id !== groupId)); setActiveId(null);
    setAnnouncement('Marca removida da pesquisa de preços.'); clearErrors();
  };

  const validateRows = (candidateGroups: Group[]): boolean => {
    const nextErrors: Record<string, string> = {};
    let nextFirst: string | undefined;
    let invalidGroup: string | undefined;
    const addError = (controlKey: string, message: string, groupId?: string) => {
      nextErrors[controlKey] = message; nextFirst ??= controlKey; invalidGroup ??= groupId;
    };
    for (const group of candidateGroups) for (const row of group.rows) {
      if (row.source === 'stock' && !row.priceBrl.trim()) continue;
      const price = normalizeMoney(row.priceBrl);
      if (!row.modelOrAmperage.trim()) addError(key(row.rowId, 'modelOrAmperage'), 'Informe o modelo ou a amperagem.', group.id);
      if (!parameters?.values.technologies.some(({ id }) => id === row.technologyId)) {
        addError(key(row.rowId, 'technologyId'), 'Selecione uma tecnologia publicada.', group.id);
      }
      if (!moneyPattern.test(price) || Number(price) <= 0) addError(key(row.rowId, 'priceBrl'),
        'Informe um preço de venda maior que zero. Exemplo: 399,90.', group.id);
      if (!parameters?.values.conditions.some(({ id }) => id === row.conditionId)) {
        addError(key(row.rowId, 'conditionId'), 'Selecione uma condição publicada.', group.id);
      }
      if (row.observation.length > 500) addError(key(row.rowId, 'observation'), 'Use no máximo 500 caracteres.', group.id);
    }
    if (!Object.keys(nextErrors).length) return true;
    if (invalidGroup) {
      setActiveId(invalidGroup);
      const invalid = groups.find(({ id }) => id === invalidGroup);
      const label = invalid ? brandLabel(invalid.competitorId) : '';
      if (ownBrands.has(label)) {
        setActiveOwnBrand(label as OwnStockBrand);
        setScreen('own-detail');
        setSearch('');
      }
    }
    setErrors(nextErrors); setFirstError(nextFirst); setFocusAttempt((value) => value + 1);
    return false;
  };
  const saveOwnBrand = () => {
    if (!activeOwnBrand || !activeGroup || !validateRows([activeGroup])) return;
    setCompletedOwnBrands((current) => current.includes(activeOwnBrand) ? current : [...current, activeOwnBrand]);
    setScreen('own-overview'); setActiveOwnBrand(null); setActiveId(null);
    setAnnouncement(`Preços de ${activeOwnBrand} preparados.`);
  };

  const validate = (): CompetitorPricesInput | undefined => {
    clearErrors();
    if (availability === 'unavailable') {
      if (!unavailableConfigured || !parameters?.values.unavailableReasons.some(({ id }) => id === unavailableReasonId)) {
        setErrors({ unavailableReasonId: 'Selecione um motivo publicado para esta visita.' });
        setFirstError('unavailableReasonId'); setFocusAttempt((value) => value + 1); return undefined;
      }
      return { availability, unavailableReasonId };
    }
    if (!configured || !parameters) {
      setErrors({ form: 'O catálogo de marcas, tecnologias e condições ainda não está disponível.' }); return undefined;
    }
    if (!groups.some(({ rows }) => rows.some((row) => row.source !== 'stock' || row.priceBrl.trim()))) {
      setErrors({ form: 'Registre ao menos um preço ou informe que o preço não estava disponível.' }); return undefined;
    }
    if (!validateRows(groups)) return undefined;
    const parsed = competitorPricesInputSchema.safeParse({ availability, quotations: groups.flatMap((group) =>
      group.rows.filter((row) => row.source !== 'stock' || row.priceBrl.trim()).map((row) => ({
        competitorId: group.competitorId, modelOrAmperage: row.modelOrAmperage,
        technologyId: row.technologyId, priceBrl: normalizeMoney(row.priceBrl), conditionId: row.conditionId,
         ...(row.productCode ? { productCode: row.productCode } : {}),
        ...(row.observation.trim() ? { observation: row.observation } : {}) }))),
    });
    if (!parsed.success) {
      setErrors({ form: 'Revise os preços antes de salvar.' }); setFirstError('form');
      setFocusAttempt((value) => value + 1); return undefined;
    }
    return parsed.data;
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (saving) return;
    const values = validate(); if (!values) return; setSaving(true);
    try { await onSave(values); }
    catch {
      setErrors({ form: 'Não foi possível salvar no aparelho. Os valores continuam nesta tela; tente novamente.' });
      setFirstError('form'); setFocusAttempt((value) => value + 1);
    } finally { setSaving(false); }
  };

  const input = (row: Row, field: 'modelOrAmperage' | 'priceBrl', label: string, placeholder: string) => <div className="seller-stock-field">
    <label htmlFor={fieldId(row.rowId, field)}>{label}</label>
    <input id={fieldId(row.rowId, field)} ref={register(key(row.rowId, field))} value={row[field]}
      inputMode={field === 'priceBrl' ? 'decimal' : undefined} maxLength={field === 'modelOrAmperage' ? 120 : undefined}
      placeholder={placeholder} aria-invalid={Boolean(fieldError(row.rowId, field))}
      aria-describedby={fieldError(row.rowId, field) ? `${fieldId(row.rowId, field)}-error` : undefined}
      onChange={(event) => activeGroup && updateRow(activeGroup.id, row.rowId, field, event.target.value)} />
    {fieldError(row.rowId, field) && <p className="seller-field-error"
      id={`${fieldId(row.rowId, field)}-error`}>{fieldError(row.rowId, field)}</p>}
  </div>;
  const detailedRow = (row: Row, index: number, group: Group) => <fieldset className="seller-stock-row" key={row.rowId}>
    <legend>Bateria {index + 1}</legend><div className="seller-stock-row-fields seller-price-row-fields">
      {input(row, 'modelOrAmperage', 'Modelo ou amperagem', 'Ex.: 60 Ah')}
      <div className="seller-stock-field"><label htmlFor={fieldId(row.rowId, 'technologyId')}>Tecnologia</label>
        <select id={fieldId(row.rowId, 'technologyId')} ref={register(key(row.rowId, 'technologyId'))}
          value={row.technologyId} aria-invalid={Boolean(fieldError(row.rowId, 'technologyId'))}
          onChange={(event) => updateRow(group.id, row.rowId, 'technologyId', event.target.value)}>
          <option value="">Selecione</option>{parameters?.values.technologies.map((technology) =>
            <option key={technology.id} value={technology.id}>{technology.label}</option>)}</select>
        {fieldError(row.rowId, 'technologyId') && <p className="seller-field-error">{fieldError(row.rowId, 'technologyId')}</p>}</div>
      {input(row, 'priceBrl', 'Preço de venda (R$)', '399,90')}
      <div className="seller-stock-field"><label htmlFor={fieldId(row.rowId, 'conditionId')}>Condição</label>
        <select id={fieldId(row.rowId, 'conditionId')} ref={register(key(row.rowId, 'conditionId'))}
          value={row.conditionId} aria-invalid={Boolean(fieldError(row.rowId, 'conditionId'))}
          onChange={(event) => updateRow(group.id, row.rowId, 'conditionId', event.target.value)}>
          <option value="">Selecione</option>{parameters?.values.conditions.map((condition) =>
            <option key={condition.id} value={condition.id}>{condition.label}</option>)}</select>
        {fieldError(row.rowId, 'conditionId') && <p className="seller-field-error">{fieldError(row.rowId, 'conditionId')}</p>}</div>
      <div className="seller-stock-field seller-price-observation"><label htmlFor={fieldId(row.rowId, 'observation')}>Observação (opcional)</label>
        <textarea id={fieldId(row.rowId, 'observation')} value={row.observation} maxLength={500}
          onChange={(event) => updateRow(group.id, row.rowId, 'observation', event.target.value)} /></div>
    </div><button className="seller-stock-remove" type="button"
      aria-label={`Remover bateria ${index + 1} da marca ${brandLabel(group.competitorId)}`}
      onClick={() => removeRow(group.id, row.rowId)}>Remover bateria</button>
  </fieldset>;

  const ownOverview = <div className="seller-price-own-flow">
    <div className="seller-stock-heading"><div><p className="seller-kicker">PESQUISA DE PREÇOS</p>
      <h2 id="prices-title" ref={titleRef} tabIndex={-1}>Preços dos nossos produtos</h2>
      <p className="seller-muted">Toque em uma marca para informar o preço de venda dos modelos.</p></div></div>
    <div className="seller-stock-overview">{OWN_STOCK_BRANDS.map((brand) => {
      const group = ownGroupFor(brand);
      const count = group?.rows.filter(({ priceBrl }) => Number(normalizeMoney(priceBrl)) > 0).length ?? 0;
      const stockCount = ownLinesForBrand(draft.stock?.ownLines, brand).filter(({ quantity }) => quantity > 0).length;
      return <button className="seller-stock-brand-card" type="button" key={brand} onClick={() => openOwnBrand(brand)}
        disabled={!ownParameter(brand)} aria-label={`${brand}: ${count} preços. Abrir produtos`}>
        <span className="seller-stock-brand-avatar" aria-hidden="true">{brand[0]}</span>
        <span className="seller-stock-brand-copy"><strong>{brand}</strong><small>{completedOwnBrands.includes(brand)
          ? 'Preços preparados' : stockCount ? `${stockCount} produto(s) encontrado(s) no estoque` : 'Toque para pesquisar preços'}</small></span>
        <strong className="seller-stock-brand-count">{count} <small>preço(s)</small></strong>
        <span className="seller-stock-brand-chevron" aria-hidden="true">›</span>
      </button>;
    })}</div>
    <button className="seller-button seller-primary seller-stock-submit" type="button"
      onClick={() => { setScreen('competitors'); setActiveId(null); clearErrors(); }}>
      Continuar para preços da concorrência</button>
  </div>;

  let ownDetail: ReactNode = null;
  if (screen === 'own-detail' && activeOwnBrand && activeGroup) {
    const normalizedSearch = search.toLocaleLowerCase('pt-BR');
    const stockLines = ownLinesForBrand(draft.stock?.ownLines, activeOwnBrand).filter(({ quantity }) => quantity > 0);
    const stockByCode = new Map(stockLines.filter(({ productCode }) => productCode).map((line) => [line.productCode as string, line]));
    const stockByModel = new Map(stockLines.map((line) => [line.model.toLocaleLowerCase('pt-BR'), line]));
    const products = ownProductItemsByBrand[activeOwnBrand].filter((product) =>
      `${product.model} ${product.description} ${product.factoryCode} ${product.sku}`.toLocaleLowerCase('pt-BR').includes(normalizedSearch))
      .sort((a, b) => Number(Boolean(stockByCode.get(b.factoryCode))) - Number(Boolean(stockByCode.get(a.factoryCode))));
    const catalogModels = new Set(ownProductItemsByBrand[activeOwnBrand].map(({ model }) => model.toLocaleLowerCase('pt-BR')));
    const additionalRows = activeGroup.rows.filter((row) => !row.productCode
      && !catalogModels.has(row.modelOrAmperage.toLocaleLowerCase('pt-BR')));
    const priced = activeGroup.rows.filter(({ priceBrl }) => Number(normalizeMoney(priceBrl)) > 0).length;
    ownDetail = <div className="seller-price-own-flow">
      <button className="seller-stock-back" type="button" onClick={() => { setScreen('own-overview'); setActiveId(null); }}>‹ Todas as marcas</button>
      <div className="seller-stock-detail-heading"><div><p className="seller-kicker">PREÇOS — PRODUTOS PRÓPRIOS</p>
        <h2 id="prices-title" ref={titleRef} tabIndex={-1}>{activeOwnBrand}</h2>
        <p className="seller-muted">Informe o preço de venda. Produtos encontrados no estoque aparecem primeiro.</p></div>
        <strong>{priced} <small>preço(s)</small></strong></div>
      <label className="seller-stock-search-label" htmlFor="own-price-search">Buscar modelo</label>
      <input id="own-price-search" className="seller-stock-search" type="search" value={search}
        placeholder="Nome ou código do modelo" onChange={(event) => setSearch(event.target.value)} />
      <p className="seller-stock-list-count">{products.length} modelo(s) da lista</p>
      <div className="seller-stock-model-list">{products.map((product) => {
        const row = rowForProduct(activeGroup, product.factoryCode, product.model);
        const stockLine = stockByCode.get(product.factoryCode) ?? stockByModel.get(product.model.toLocaleLowerCase('pt-BR'));
        const error = row ? fieldError(row.rowId, 'priceBrl') : undefined;
        return <div className={`seller-stock-model-row seller-price-product-row${stockLine ? ' is-in-stock' : ''}`} key={product.id}>
          <label htmlFor={`catalog-price-${product.factoryCode}`}>{product.model}<small>{product.factoryCode}
            {stockLine ? ` · Em estoque: ${stockLine.quantity} un.` : ''}</small></label>
          <div className="seller-price-catalog-control"><span>R$</span><input id={`catalog-price-${product.factoryCode}`}
            ref={row ? register(key(row.rowId, 'priceBrl')) : undefined} inputMode="decimal" placeholder="0,00"
            aria-label={`Preço de venda de ${product.model}`} value={row?.priceBrl ?? ''} aria-invalid={Boolean(error)}
            aria-describedby={error && row ? `${fieldId(row.rowId, 'priceBrl')}-error` : undefined}
            onChange={(event) => setCatalogPrice(activeGroup, product.factoryCode, product.model, event.target.value)} /></div>
          {error && row && <p className="seller-field-error" id={`${fieldId(row.rowId, 'priceBrl')}-error`}>{error}</p>}
        </div>;
      })}{!products.length && <p className="seller-muted">Nenhum modelo encontrado. Adicione outra bateria se não estiver cadastrada.</p>}</div>
      {additionalRows.length > 0 && <div className="seller-stock-row-list seller-price-additional-list">
        <h3>Baterias adicionais</h3>{additionalRows.map((row, index) => detailedRow(row, index, activeGroup))}</div>}
      <button className="seller-button seller-secondary seller-stock-add" type="button"
        disabled={totalRows >= 25} onClick={() => addManualRow(activeGroup.id)}>＋ Adicionar outra bateria</button>
      {errors.form && <p className="seller-form-error" role="alert">{errors.form}</p>}
      <button className="seller-button seller-primary seller-stock-submit" type="button" onClick={saveOwnBrand}>Salvar {activeOwnBrand}</button>
    </div>;
  }

  const competitorGroups = groups.filter(({ competitorId }) => !ownBrands.has(brandLabel(competitorId)));
  const competitorView = <div className="seller-price-collection">
    <button className="seller-stock-back" type="button" onClick={() => { setScreen('own-overview'); setActiveId(null); }}>‹ Nossos produtos</button>
    <div className="seller-stock-heading"><div><p className="seller-kicker">PREÇOS DA CONCORRÊNCIA</p>
      <h2 id="prices-title" ref={titleRef} tabIndex={-1}>Marcas concorrentes</h2>
      <p className="seller-muted">Selecione a marca e registre as baterias encontradas no PDV.</p></div></div>
    <div className="seller-stock-brand-picker seller-price-brand-picker"><h3>Selecione as marcas</h3>
      <div className="seller-stock-brand-options">{competitorCatalog.map((brand) => <button key={brand.id}
        className="seller-stock-brand-option" type="button" aria-pressed={activeGroup?.competitorId === brand.id}
        onClick={() => selectCompetitorBrand(brand.id)}><span aria-hidden="true">{groups.some(({ competitorId }) => competitorId === brand.id) ? '✓' : '＋'}</span>{brand.label}</button>)}</div></div>
    {competitorGroups.length > 0 && <div className="seller-stock-added-brands"><h3>Marcas adicionadas</h3>
      <div className="seller-stock-added-list">{competitorGroups.map((group) => <button key={group.id} type="button"
        className="seller-stock-added-brand" aria-pressed={activeId === group.id} onClick={() => setActiveId(group.id)}>
        <span>{brandLabel(group.competitorId)}</span><small>{group.rows.length} {group.rows.length === 1 ? 'preço' : 'preços'}</small></button>)}</div></div>}
    {activeGroup && !ownBrands.has(brandLabel(activeGroup.competitorId)) && <fieldset className="seller-stock-brand-panel seller-price-brand-panel">
      <legend>Preços — {brandLabel(activeGroup.competitorId)}</legend><div className="seller-stock-row-list">
        {activeGroup.rows.map((row, index) => detailedRow(row, index, activeGroup))}</div>
      <button className="seller-button seller-secondary seller-stock-add" type="button" ref={register('add-row')}
        disabled={totalRows >= 25} onClick={() => addManualRow(activeGroup.id)}>＋ Adicionar outra bateria</button>
      <button className="seller-stock-remove seller-stock-remove-brand" type="button"
        onClick={() => removeGroup(activeGroup.id)}>Remover esta marca</button></fieldset>}
    {errors.form && <p className="seller-form-error" ref={register('form')} role="alert" tabIndex={-1}>{errors.form}</p>}
    <button className="seller-button seller-primary seller-stock-submit" type="submit" disabled={saving || !configured}>
      {saving ? 'Salvando no aparelho…' : 'Salvar preços e continuar'}</button>
  </div>;

  return <section className="seller-stock-card seller-prices-card seller-stock-collection" aria-labelledby="prices-title">
    {!configured && !unavailableConfigured && <p className="seller-notice" role="status">
      Configuração comercial indisponível. Nenhuma resposta será gravada até a publicação das listas aprovadas.</p>}
    <form className="seller-stock-form seller-prices-form" onSubmit={submit} noValidate>
      {screen !== 'own-detail' && <fieldset className="seller-choice-group"><legend>O preço estava disponível?</legend>
        <label><input ref={register('availability')} type="radio" name="priceAvailability" checked={availability === 'available'}
          disabled={!configured && draft.prices?.availability !== 'available'} onChange={() => { setAvailability('available'); clearErrors(); }} /> Sim, registrar preços</label>
        <label><input type="radio" name="priceAvailability" checked={availability === 'unavailable'}
          disabled={!unavailableConfigured && draft.prices?.availability !== 'unavailable'}
          onChange={() => { setAvailability('unavailable'); clearErrors(); }} /> Preço não disponível</label></fieldset>}
      {availability === 'unavailable' ? <div className="seller-price-unavailable">
        <h2 id="prices-title" ref={titleRef} tabIndex={-1}>Preço não disponível</h2>
        <label htmlFor="price-unavailable-reason">Motivo da indisponibilidade</label>
        <select id="price-unavailable-reason" ref={register('unavailableReasonId')} value={unavailableReasonId}
          aria-invalid={Boolean(errors.unavailableReasonId)} onChange={(event) => setUnavailableReasonId(event.target.value)}>
          <option value="">Selecione</option>{parameters?.values.unavailableReasons.map((reason) =>
            <option key={reason.id} value={reason.id}>{reason.label}</option>)}</select>
        {errors.unavailableReasonId && <p className="seller-field-error">{errors.unavailableReasonId}</p>}
        <button className="seller-button seller-primary seller-stock-submit" type="submit" disabled={saving || !unavailableConfigured}>
          {saving ? 'Salvando no aparelho…' : 'Salvar preços e continuar'}</button></div>
        : screen === 'own-overview' ? ownOverview : screen === 'own-detail' ? ownDetail : competitorView}
      <p className="seller-sr-only" role="status">{announcement}</p>
    </form>
  </section>;
}
