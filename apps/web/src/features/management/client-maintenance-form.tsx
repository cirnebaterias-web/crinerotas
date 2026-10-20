'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  clientDetailSchema,
  clientMutationResponseSchema,
  clientPath,
  clientsPath,
  createClientRequestSchema,
  updateClientRequestSchema,
  type ClientDetail,
  type ClientSeller,
} from '@cirne/contracts';
import { scrapRequest, ScrapRequestError } from '@/features/scrap/scrap-ui';

type Values = {
  externalReference: string;
  name: string;
  address: string;
  latitude: string;
  longitude: string;
  portfolioReference: string;
  sellerEmail: string;
  status: 'active' | 'archived';
  reason: string;
};

const blank = (sellerEmail = ''): Values => ({
  externalReference: '', name: '', address: '', latitude: '', longitude: '',
  portfolioReference: '', sellerEmail, status: 'active', reason: '',
});

function valuesFromClient(client: ClientDetail): Values {
  return {
    externalReference: client.externalReference,
    name: client.name,
    address: client.address,
    latitude: client.latitude === null ? '' : String(client.latitude),
    longitude: client.longitude === null ? '' : String(client.longitude),
    portfolioReference: client.portfolioReference ?? '',
    sellerEmail: client.sellerEmail ?? '',
    status: client.status,
    reason: '',
  };
}

function numberOrNull(value: string) {
  if (!value.trim()) return null;
  return Number(value.trim().replace(',', '.'));
}

export function ClientMaintenanceForm({
  client,
  sellers,
  onCancel,
  onEditExisting,
  onSaved,
}: {
  client: ClientDetail | null;
  sellers: ClientSeller[];
  onCancel(): void;
  onEditExisting(client: ClientDetail): void;
  onSaved(client: ClientDetail): Promise<void>;
}) {
  const [values, setValues] = useState<Values>(() => client ? valuesFromClient(client) : blank(sellers[0]?.email));
  const [expectedVersion, setExpectedVersion] = useState(client?.version ?? 1);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState('');
  const [conflict, setConflict] = useState<ClientDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setValues(client ? valuesFromClient(client) : blank(sellers[0]?.email));
    setExpectedVersion(client?.version ?? 1);
    setErrors({}); setMessage(''); setConflict(null); setIdempotencyKey(null);
  }, [client, sellers]);

  function change<K extends keyof Values>(name: K, value: Values[K]) {
    setValues((current) => ({ ...current, [name]: value }));
    setErrors((current) => ({ ...current, [name]: '' }));
    setMessage(''); setConflict(null); setIdempotencyKey(null);
  }

  function showValidation(issues: readonly { path: PropertyKey[]; message: string }[]) {
    const next: Record<string, string> = {};
    for (const issue of issues) {
      const field = String(issue.path[0] ?? 'form');
      if (!next[field]) next[field] = issue.message;
    }
    setErrors(next);
    setMessage('Revise os campos indicados antes de salvar.');
    queueMicrotask(() => {
      summaryRef.current?.focus();
      const first = Object.keys(next)[0];
      if (first) formRef.current?.querySelector<HTMLElement>(`[name="${first}"]`)?.focus();
    });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const fields = {
      schemaVersion: 1 as const,
      name: values.name,
      address: values.address,
      latitude: numberOrNull(values.latitude),
      longitude: numberOrNull(values.longitude),
      portfolioReference: values.portfolioReference,
      sellerEmail: values.sellerEmail,
      status: values.status,
    };
    const parsed = client
      ? updateClientRequestSchema.safeParse({ ...fields, expectedVersion, reason: values.reason })
      : createClientRequestSchema.safeParse({ ...fields, externalReference: values.externalReference });
    if (!parsed.success) { showValidation(parsed.error.issues); return; }
    const key = idempotencyKey ?? crypto.randomUUID();
    setIdempotencyKey(key); setBusy(true); setErrors({}); setMessage(''); setConflict(null);
    try {
      const result = clientMutationResponseSchema.parse(await scrapRequest(
        client ? clientPath(client.id) : clientsPath,
        {
          method: client ? 'PATCH' : 'POST',
          headers: { 'content-type': 'application/json', 'x-csrf-token': 'cirne-route-v1', 'idempotency-key': key },
          body: JSON.stringify(parsed.data),
        },
      ));
      setIdempotencyKey(null);
      setMessage(result.replayed ? 'A confirmação anterior foi recuperada.' : 'Cliente salvo no banco.');
      await onSaved(result.client);
      if (!client) setValues(blank(sellers[0]?.email));
    } catch (error) {
      if (error instanceof ScrapRequestError && error.status === 409) {
        const current = clientDetailSchema.safeParse(error.details?.current);
        if (current.success) setConflict(current.data);
        setIdempotencyKey(null);
      }
      setMessage(error instanceof Error ? error.message : 'Não foi possível salvar. Os dados foram preservados.');
    } finally { setBusy(false); }
  }

  const fieldError = (name: keyof Values) => errors[name]
    ? <p className="seller-field-error" id={`client-${name}-error`}>{errors[name]}</p> : null;
  const describedBy = (name: keyof Values) => errors[name] ? `client-${name}-error` : undefined;

  return <form className="seller-stock-card seller-stock-form" ref={formRef} onSubmit={submit} aria-busy={busy} noValidate>
    <h2>{client ? 'Corrigir cliente' : 'Novo cliente'}</h2>
    <p>{client ? `Versão atual: ${expectedVersion}. Informe o motivo da correção.` : 'O cadastro ficará disponível imediatamente na carteira selecionada.'}</p>
    {message && <div className="seller-notice" role={Object.keys(errors).length ? 'alert' : 'status'} tabIndex={-1} ref={summaryRef}>{message}</div>}
    {Object.keys(errors).length > 0 && <ul aria-label="Resumo dos erros">{Object.entries(errors).map(([field, error]) => <li key={field}>{error}</li>)}</ul>}
    <div className="seller-form-grid">
      <label>Referência externa<input name="externalReference" required maxLength={120} disabled={busy || Boolean(client)} value={values.externalReference} onChange={(event) => change('externalReference', event.target.value)} aria-invalid={Boolean(errors.externalReference)} aria-describedby={describedBy('externalReference')} />{fieldError('externalReference')}</label>
      <label>Nome<input name="name" required maxLength={160} disabled={busy} value={values.name} onChange={(event) => change('name', event.target.value)} aria-invalid={Boolean(errors.name)} aria-describedby={describedBy('name')} />{fieldError('name')}</label>
    </div>
    <label>Endereço completo<textarea name="address" required maxLength={300} rows={3} disabled={busy} value={values.address} onChange={(event) => change('address', event.target.value)} aria-invalid={Boolean(errors.address)} aria-describedby={describedBy('address')} />{fieldError('address')}</label>
    <div className="seller-form-grid">
      <label>Latitude (opcional)<input name="latitude" inputMode="decimal" disabled={busy} value={values.latitude} onChange={(event) => change('latitude', event.target.value)} aria-invalid={Boolean(errors.latitude)} aria-describedby={describedBy('latitude')} />{fieldError('latitude')}</label>
      <label>Longitude (opcional)<input name="longitude" inputMode="decimal" disabled={busy} value={values.longitude} onChange={(event) => change('longitude', event.target.value)} aria-invalid={Boolean(errors.longitude)} aria-describedby={describedBy('longitude')} />{fieldError('longitude')}</label>
      <label>Referência de carteira<input name="portfolioReference" maxLength={120} disabled={busy} value={values.portfolioReference} onChange={(event) => change('portfolioReference', event.target.value)} aria-invalid={Boolean(errors.portfolioReference)} aria-describedby={describedBy('portfolioReference')} />{fieldError('portfolioReference')}</label>
      <label>Vendedor responsável<select name="sellerEmail" required disabled={busy || sellers.length === 0} value={values.sellerEmail} onChange={(event) => change('sellerEmail', event.target.value)} aria-invalid={Boolean(errors.sellerEmail)} aria-describedby={describedBy('sellerEmail')}><option value="">Selecione</option>{sellers.map((seller) => <option key={seller.id} value={seller.email}>{seller.displayName} · {seller.email}</option>)}</select>{fieldError('sellerEmail')}</label>
      <label>Status<select name="status" disabled={busy} value={values.status} onChange={(event) => change('status', event.target.value as Values['status'])}><option value="active">Ativo</option><option value="archived">Inativo</option></select></label>
    </div>
    {client && <label>Motivo da correção<textarea name="reason" required maxLength={500} rows={3} disabled={busy} value={values.reason} onChange={(event) => change('reason', event.target.value)} aria-invalid={Boolean(errors.reason)} aria-describedby={describedBy('reason')} />{fieldError('reason')}</label>}
    {sellers.length === 0 && <p className="seller-notice" role="alert">Nenhum vendedor ativo está disponível na sua abrangência.</p>}
    {conflict && <section className="seller-notice" aria-labelledby="client-conflict-title"><h3 id="client-conflict-title">Estado atual no servidor</h3><p>{conflict.name} · versão {conflict.version} · {conflict.status === 'active' ? 'Ativo' : 'Inativo'}</p><p>{conflict.address}</p><button type="button" className="seller-button seller-secondary" onClick={() => {
      if (!client) { onEditExisting(conflict); return; }
      setValues(valuesFromClient(conflict)); setExpectedVersion(conflict.version); setConflict(null);
      setMessage('Estado atual carregado. Revise e informe novamente o motivo.');
    }}>{client ? 'Carregar estado atual' : 'Corrigir cadastro existente'}</button></section>}
    <div className="seller-evidence-actions"><button type="button" className="seller-button seller-secondary" disabled={busy} onClick={onCancel}>Cancelar</button><button className="seller-button seller-primary" disabled={busy || sellers.length === 0}>{busy ? 'Salvando…' : 'Salvar cliente'}</button></div>
  </form>;
}
