'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  competitorPricesInputSchema,
  type CompetitorPricesInput,
  type LocalCompetitorPriceParameterSet,
  type LocalVisitDraft,
} from '@cirne/contracts';

interface VisitCompetitorPricesStepProps {
  draft: LocalVisitDraft;
  parameters: LocalCompetitorPriceParameterSet | null;
  onSave: (values: CompetitorPricesInput) => Promise<void>;
}

type Availability = CompetitorPricesInput['availability'];
type QuotationField = 'competitorId' | 'modelOrAmperage' | 'technologyId' | 'priceBrl' |
  'conditionId' | 'observation';

interface EditableQuotation {
  rowId: string;
  competitorId: string;
  modelOrAmperage: string;
  technologyId: string;
  priceBrl: string;
  conditionId: string;
  observation: string;
}

const moneyPattern = /^\d+(?:\.\d+)?$/;

function normalizeMoneyInput(value: string) {
  return /^\d+,\d+$/.test(value) ? value.replace(',', '.') : value;
}

function emptyQuotation(rowId: string): EditableQuotation {
  return {
    rowId,
    competitorId: '',
    modelOrAmperage: '',
    technologyId: '',
    priceBrl: '',
    conditionId: '',
    observation: '',
  };
}

function initialQuotations(draft: LocalVisitDraft): EditableQuotation[] {
  if (draft.prices?.availability !== 'available') return [emptyQuotation('new-1')];
  return draft.prices.quotations.map((quotation, index) => ({
    rowId: `saved-${index + 1}`,
    competitorId: quotation.competitorId,
    modelOrAmperage: quotation.modelOrAmperage,
    technologyId: quotation.technologyId,
    priceBrl: quotation.priceBrl,
    conditionId: quotation.conditionId,
    observation: quotation.observation ?? '',
  }));
}

function errorKey(rowId: string, field: QuotationField) {
  return `${rowId}.${field}`;
}

export function VisitCompetitorPricesStep({
  draft,
  parameters,
  onSave,
}: VisitCompetitorPricesStepProps) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const controlRefs = useRef<Record<string, HTMLElement | null>>({});
  const pendingQuotationFocus = useRef<string | undefined>(undefined);
  const nextRow = useRef(initialQuotations(draft).length + 1);
  const availableConfigured = Boolean(
    parameters?.values.competitors.length &&
    parameters.values.technologies.length &&
    parameters.values.conditions.length,
  );
  const unavailableConfigured = Boolean(parameters?.values.unavailableReasons.length);
  const initialAvailability = draft.prices?.availability ?? (
    availableConfigured ? 'available' : unavailableConfigured ? 'unavailable' : 'available'
  );
  const [availability, setAvailability] = useState<Availability>(initialAvailability);
  const [quotations, setQuotations] = useState(() => initialQuotations(draft));
  const [unavailableReasonId, setUnavailableReasonId] = useState(
    draft.prices?.availability === 'unavailable' ? draft.prices.unavailableReasonId : '',
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [firstError, setFirstError] = useState<string>();
  const [focusAttempt, setFocusAttempt] = useState(0);
  const [quotationStatus, setQuotationStatus] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => { titleRef.current?.focus(); }, []);
  useEffect(() => {
    if (firstError) controlRefs.current[firstError]?.focus();
  }, [firstError, focusAttempt]);
  useEffect(() => {
    const key = pendingQuotationFocus.current;
    if (!key) return;
    pendingQuotationFocus.current = undefined;
    controlRefs.current[key]?.focus();
  }, [quotations]);

  const registerControl = (key: string) => (element: HTMLElement | null) => {
    controlRefs.current[key] = element;
  };
  const fieldError = (rowId: string, field: QuotationField) => errors[errorKey(rowId, field)];
  const fieldId = (rowId: string, field: QuotationField) => `price-${rowId}-${field}`;
  const fieldErrorId = (rowId: string, field: QuotationField) => `${fieldId(rowId, field)}-error`;

  const updateQuotation = (rowId: string, field: QuotationField, value: string) => {
    setQuotations((current) => current.map((quotation) => (
      quotation.rowId === rowId ? { ...quotation, [field]: value } : quotation
    )));
  };

  const addQuotation = () => {
    if (quotations.length >= 25) return;
    const rowId = `new-${nextRow.current++}`;
    pendingQuotationFocus.current = errorKey(rowId, 'competitorId');
    setQuotations((current) => [...current, emptyQuotation(rowId)]);
    setQuotationStatus(`Cotação ${quotations.length + 1} adicionada.`);
    setErrors({});
    setFirstError(undefined);
  };

  const removeQuotation = (rowId: string) => {
    if (quotations.length === 1) return;
    pendingQuotationFocus.current = 'addQuotation';
    setQuotations((current) => current.filter((quotation) => quotation.rowId !== rowId));
    setQuotationStatus(`Cotação removida. ${quotations.length - 1} restante(s).`);
    setErrors({});
    setFirstError(undefined);
  };

  const validate = (): CompetitorPricesInput | undefined => {
    const nextErrors: Record<string, string> = {};
    let nextFirstError: string | undefined;
    const addError = (key: string, message: string) => {
      nextErrors[key] = message;
      nextFirstError ??= key;
    };

    if (availability === 'unavailable') {
      if (!unavailableConfigured) {
        addError('form', 'Os motivos de indisponibilidade ainda não foram publicados para esta visita.');
      } else if (!parameters?.values.unavailableReasons.some(({ id }) => id === unavailableReasonId)) {
        addError('unavailableReasonId', 'Selecione um motivo publicado para esta visita.');
      }
      if (Object.keys(nextErrors).length) {
        setErrors(nextErrors);
        setFirstError(nextFirstError);
        setFocusAttempt((attempt) => attempt + 1);
        return undefined;
      }
      return { availability, unavailableReasonId };
    }

    if (!availableConfigured || !parameters) {
      addError('form', 'O catálogo de concorrentes, tecnologias e condições ainda não está disponível para esta visita.');
    } else {
      for (const quotation of quotations) {
        const normalizedPrice = normalizeMoneyInput(quotation.priceBrl);
        if (!parameters.values.competitors.some(({ id }) => id === quotation.competitorId)) {
          addError(errorKey(quotation.rowId, 'competitorId'), 'Selecione um concorrente publicado.');
        }
        if (!quotation.modelOrAmperage.trim()) {
          addError(errorKey(quotation.rowId, 'modelOrAmperage'), 'Informe o modelo ou a amperagem.');
        }
        if (!parameters.values.technologies.some(({ id }) => id === quotation.technologyId)) {
          addError(errorKey(quotation.rowId, 'technologyId'), 'Selecione uma tecnologia publicada.');
        }
        if (!moneyPattern.test(normalizedPrice) || Number(normalizedPrice) <= 0) {
          addError(errorKey(quotation.rowId, 'priceBrl'), 'Informe um preço maior que zero, sem arredondamento. Exemplo: 399,90.');
        }
        if (!parameters.values.conditions.some(({ id }) => id === quotation.conditionId)) {
          addError(errorKey(quotation.rowId, 'conditionId'), 'Selecione uma condição publicada.');
        }
        if (quotation.observation.length > 500) {
          addError(errorKey(quotation.rowId, 'observation'), 'Use no máximo 500 caracteres.');
        }
      }
    }

    if (Object.keys(nextErrors).length) {
      setErrors(nextErrors);
      setFirstError(nextFirstError);
      setFocusAttempt((attempt) => attempt + 1);
      return undefined;
    }

    const parsed = competitorPricesInputSchema.safeParse({
      availability,
      quotations: quotations.map((quotation) => ({
        competitorId: quotation.competitorId,
        modelOrAmperage: quotation.modelOrAmperage,
        technologyId: quotation.technologyId,
        priceBrl: normalizeMoneyInput(quotation.priceBrl),
        conditionId: quotation.conditionId,
        ...(quotation.observation.trim() ? { observation: quotation.observation } : {}),
      })),
    });
    if (!parsed.success) {
      setErrors({ form: 'Revise as cotações antes de salvar.' });
      setFirstError('form');
      setFocusAttempt((attempt) => attempt + 1);
      return undefined;
    }
    return parsed.data;
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrors({});
    setFirstError(undefined);
    const values = validate();
    if (!values) return;
    setSaving(true);
    try {
      await onSave(values);
    } catch {
      setErrors({ form: 'Não foi possível salvar no aparelho. Os valores continuam nesta tela; tente novamente.' });
      setFirstError('form');
      setFocusAttempt((attempt) => attempt + 1);
    } finally {
      setSaving(false);
    }
  };

  const switchAvailability = (value: Availability) => {
    setAvailability(value);
    setErrors({});
    setFirstError(undefined);
  };

  return <section className="seller-stock-card seller-prices-card" aria-labelledby="prices-title">
    {draft.prices && <p className="seller-kicker">ETAPA 2 DE 4</p>}
    <h2 id="prices-title" ref={titleRef} tabIndex={-1}>Preços da concorrência</h2>
    <p className="seller-muted">Registre cada cotação observada ou informe explicitamente que o preço não estava disponível.</p>
    {!availableConfigured && !unavailableConfigured && <p className="seller-notice" role="status">
      Configuração comercial indisponível. Nenhuma resposta será gravada até a publicação das listas aprovadas.
    </p>}
    <form className="seller-stock-form seller-prices-form" onSubmit={submit} noValidate>
      <fieldset className="seller-choice-group">
        <legend>O preço estava disponível?</legend>
        <label>
          <input
            ref={registerControl('availability')}
            type="radio"
            name="priceAvailability"
            checked={availability === 'available'}
            disabled={!availableConfigured && draft.prices?.availability !== 'available'}
            onChange={() => switchAvailability('available')}
          />
          Sim, registrar cotações
        </label>
        <label>
          <input
            type="radio"
            name="priceAvailability"
            checked={availability === 'unavailable'}
            disabled={!unavailableConfigured && draft.prices?.availability !== 'unavailable'}
            onChange={() => switchAvailability('unavailable')}
          />
          Preço não disponível
        </label>
      </fieldset>

      {availability === 'unavailable' && <div className="seller-price-unavailable">
        <label htmlFor="price-unavailable-reason">Motivo da indisponibilidade</label>
        <select
          id="price-unavailable-reason"
          ref={registerControl('unavailableReasonId')}
          value={unavailableReasonId}
          aria-invalid={Boolean(errors.unavailableReasonId)}
          aria-describedby={errors.unavailableReasonId ? 'price-unavailable-reason-error' : undefined}
          onChange={(event) => setUnavailableReasonId(event.target.value)}
        >
          <option value="">Selecione</option>
          {parameters?.values.unavailableReasons.map((reason) => (
            <option key={reason.id} value={reason.id}>{reason.label}</option>
          ))}
        </select>
        {errors.unavailableReasonId && <p className="seller-field-error" id="price-unavailable-reason-error">
          {errors.unavailableReasonId}
        </p>}
      </div>}

      {availability === 'available' && <div className="seller-quotation-list">
        {quotations.map((quotation, index) => <fieldset className="seller-quotation" key={quotation.rowId}>
          <legend>Cotação {index + 1}</legend>
          <label htmlFor={fieldId(quotation.rowId, 'competitorId')}>Marca ou concorrente</label>
          <select
            id={fieldId(quotation.rowId, 'competitorId')}
            ref={registerControl(errorKey(quotation.rowId, 'competitorId'))}
            value={quotation.competitorId}
            aria-invalid={Boolean(fieldError(quotation.rowId, 'competitorId'))}
            aria-describedby={fieldError(quotation.rowId, 'competitorId')
              ? fieldErrorId(quotation.rowId, 'competitorId')
              : undefined}
            onChange={(event) => updateQuotation(quotation.rowId, 'competitorId', event.target.value)}
          >
            <option value="">Selecione</option>
            {parameters?.values.competitors.map((competitor) => (
              <option key={competitor.id} value={competitor.id}>{competitor.label}</option>
            ))}
          </select>
          {fieldError(quotation.rowId, 'competitorId') && <p
            className="seller-field-error"
            id={fieldErrorId(quotation.rowId, 'competitorId')}
          >
            {fieldError(quotation.rowId, 'competitorId')}
          </p>}

          <label htmlFor={fieldId(quotation.rowId, 'modelOrAmperage')}>Modelo ou amperagem</label>
          <input
            id={fieldId(quotation.rowId, 'modelOrAmperage')}
            ref={registerControl(errorKey(quotation.rowId, 'modelOrAmperage'))}
            value={quotation.modelOrAmperage}
            maxLength={120}
            aria-invalid={Boolean(fieldError(quotation.rowId, 'modelOrAmperage'))}
            aria-describedby={fieldError(quotation.rowId, 'modelOrAmperage')
              ? fieldErrorId(quotation.rowId, 'modelOrAmperage')
              : undefined}
            onChange={(event) => updateQuotation(quotation.rowId, 'modelOrAmperage', event.target.value)}
          />
          {fieldError(quotation.rowId, 'modelOrAmperage') && <p
            className="seller-field-error"
            id={fieldErrorId(quotation.rowId, 'modelOrAmperage')}
          >
            {fieldError(quotation.rowId, 'modelOrAmperage')}
          </p>}

          <label htmlFor={fieldId(quotation.rowId, 'technologyId')}>Tecnologia</label>
          <select
            id={fieldId(quotation.rowId, 'technologyId')}
            ref={registerControl(errorKey(quotation.rowId, 'technologyId'))}
            value={quotation.technologyId}
            aria-invalid={Boolean(fieldError(quotation.rowId, 'technologyId'))}
            aria-describedby={fieldError(quotation.rowId, 'technologyId')
              ? fieldErrorId(quotation.rowId, 'technologyId')
              : undefined}
            onChange={(event) => updateQuotation(quotation.rowId, 'technologyId', event.target.value)}
          >
            <option value="">Selecione</option>
            {parameters?.values.technologies.map((technology) => (
              <option key={technology.id} value={technology.id}>{technology.label}</option>
            ))}
          </select>
          {fieldError(quotation.rowId, 'technologyId') && <p
            className="seller-field-error"
            id={fieldErrorId(quotation.rowId, 'technologyId')}
          >
            {fieldError(quotation.rowId, 'technologyId')}
          </p>}

          <label htmlFor={fieldId(quotation.rowId, 'priceBrl')}>Preço em BRL</label>
          <input
            id={fieldId(quotation.rowId, 'priceBrl')}
            ref={registerControl(errorKey(quotation.rowId, 'priceBrl'))}
            value={quotation.priceBrl}
            inputMode="decimal"
            placeholder="399.90"
            aria-invalid={Boolean(fieldError(quotation.rowId, 'priceBrl'))}
            aria-describedby={fieldError(quotation.rowId, 'priceBrl')
              ? fieldErrorId(quotation.rowId, 'priceBrl')
              : undefined}
            onChange={(event) => updateQuotation(quotation.rowId, 'priceBrl', event.target.value)}
          />
          {fieldError(quotation.rowId, 'priceBrl') && <p
            className="seller-field-error"
            id={fieldErrorId(quotation.rowId, 'priceBrl')}
          >
            {fieldError(quotation.rowId, 'priceBrl')}
          </p>}

          <label htmlFor={fieldId(quotation.rowId, 'conditionId')}>Condição</label>
          <select
            id={fieldId(quotation.rowId, 'conditionId')}
            ref={registerControl(errorKey(quotation.rowId, 'conditionId'))}
            value={quotation.conditionId}
            aria-invalid={Boolean(fieldError(quotation.rowId, 'conditionId'))}
            aria-describedby={fieldError(quotation.rowId, 'conditionId')
              ? fieldErrorId(quotation.rowId, 'conditionId')
              : undefined}
            onChange={(event) => updateQuotation(quotation.rowId, 'conditionId', event.target.value)}
          >
            <option value="">Selecione</option>
            {parameters?.values.conditions.map((condition) => (
              <option key={condition.id} value={condition.id}>{condition.label}</option>
            ))}
          </select>
          {fieldError(quotation.rowId, 'conditionId') && <p
            className="seller-field-error"
            id={fieldErrorId(quotation.rowId, 'conditionId')}
          >
            {fieldError(quotation.rowId, 'conditionId')}
          </p>}

          <label htmlFor={fieldId(quotation.rowId, 'observation')}>Observação da cotação (opcional)</label>
          <textarea
            id={fieldId(quotation.rowId, 'observation')}
            ref={registerControl(errorKey(quotation.rowId, 'observation'))}
            value={quotation.observation}
            maxLength={500}
            aria-invalid={Boolean(fieldError(quotation.rowId, 'observation'))}
            aria-describedby={[
              `${fieldId(quotation.rowId, 'observation')}-hint`,
              fieldError(quotation.rowId, 'observation')
                ? fieldErrorId(quotation.rowId, 'observation')
                : undefined,
            ].filter(Boolean).join(' ')}
            onChange={(event) => updateQuotation(quotation.rowId, 'observation', event.target.value)}
          />
          <p className="seller-field-hint" id={`${fieldId(quotation.rowId, 'observation')}-hint`}>
            {quotation.observation.length}/500 caracteres
          </p>
          {fieldError(quotation.rowId, 'observation') && <p
            className="seller-field-error"
            id={fieldErrorId(quotation.rowId, 'observation')}
          >
            {fieldError(quotation.rowId, 'observation')}
          </p>}
          {quotations.length > 1 && <button
            className="seller-button seller-secondary seller-remove-quotation"
            type="button"
            onClick={() => removeQuotation(quotation.rowId)}
          >Remover cotação {index + 1}</button>}
        </fieldset>)}
        <button
          ref={registerControl('addQuotation')}
          className="seller-button seller-secondary seller-add-quotation"
          type="button"
          disabled={quotations.length >= 25}
          onClick={addQuotation}
        >Adicionar outra cotação</button>
        <p className="seller-sr-only" role="status">{quotationStatus}</p>
      </div>}

      {errors.form && <p
        className="seller-form-error"
        ref={registerControl('form')}
        role="alert"
        tabIndex={-1}
      >{errors.form}</p>}
      <button
        className="seller-button seller-primary seller-stock-submit"
        disabled={saving || (availability === 'available' ? !availableConfigured : !unavailableConfigured)}
        type="submit"
      >{saving ? 'Salvando no aparelho…' : 'Salvar preços e continuar'}</button>
    </form>
  </section>;
}
