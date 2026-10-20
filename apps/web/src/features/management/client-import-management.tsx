'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  clientImportBatchSchema,
  clientImportPreviewSchema,
  clientListResponseSchema,
  clientSellerListResponseSchema,
  clientImportsPath,
  clientImportsValidatePath,
  clientSellersPath,
  clientsPath,
  mePath,
  meResponseSchema,
  type ClientDetail,
  type ClientImportBatch,
  type ClientImportPreview,
  type ClientSeller,
  type ImportedClient,
  type MeResponse,
} from '@cirne/contracts';
import { ClientMaintenanceForm } from './client-maintenance-form';
import { ScrapShell, scrapRequest } from '@/features/scrap/scrap-ui';

async function sendFile(path: string, file: File) {
  const form = new FormData();
  form.set('file', file);
  return scrapRequest(path, {
    method: 'POST',
    headers: { 'x-csrf-token': 'cirne-route-v1' },
    body: form,
  });
}

export function ClientImportManagement() {
  const [identity, setIdentity] = useState<MeResponse | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ClientImportPreview | null>(null);
  const [batch, setBatch] = useState<ClientImportBatch | null>(null);
  const [clients, setClients] = useState<ImportedClient[]>([]);
  const [sellers, setSellers] = useState<ClientSeller[]>([]);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ClientDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const loadClients = useCallback(async () => {
    const result = clientListResponseSchema.parse(await scrapRequest(clientsPath));
    setClients(result.clients);
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const currentIdentity = meResponseSchema.parse(await scrapRequest(mePath));
        if (!active) return;
        setIdentity(currentIdentity);
        const canRead = currentIdentity.capabilities.includes('clients.read');
        const canManage = currentIdentity.capabilities.includes('clients.manage');
        const canImport = currentIdentity.capabilities.includes('clients.import');
        if (!canRead || (!canManage && !canImport)) {
          setMessage('Seu perfil não tem acesso à gestão de clientes.');
          return;
        }
        const [clientResult, sellerResult] = await Promise.all([
          scrapRequest(clientsPath),
          canManage ? scrapRequest(clientSellersPath) : Promise.resolve(null),
        ]);
        if (!active) return;
        setClients(clientListResponseSchema.parse(clientResult).clients);
        if (sellerResult) {
          setSellers(clientSellerListResponseSchema.parse(sellerResult).sellers);
        }
      } catch (error) {
        if (active) setMessage(error instanceof Error ? error.message : 'Não foi possível consultar clientes.');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, []);

  const canManage = identity?.capabilities.includes('clients.manage') ?? false;
  const canImport = identity?.capabilities.includes('clients.import') ?? false;

  async function validate() {
    if (!file) { setMessage('Selecione uma planilha .xlsx.'); return; }
    setBusy(true); setMessage(''); setBatch(null);
    try {
      const result = clientImportPreviewSchema.parse(await sendFile(clientImportsValidatePath, file));
      setPreview(result);
      setMessage(result.rejectedCount === 0
        ? 'Planilha válida e pronta para importar.'
        : 'Revise as rejeições ou importe somente as linhas aceitas.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Não foi possível validar.');
    } finally { setBusy(false); }
  }

  async function execute() {
    if (!file) { setMessage('Selecione uma planilha .xlsx.'); return; }
    setBusy(true); setMessage('');
    try {
      const result = clientImportBatchSchema.parse(await sendFile(clientImportsPath, file));
      setBatch(result); setPreview(null); await loadClients();
      setMessage(result.replayed
        ? 'Este conteúdo já havia sido importado; o resultado anterior foi recuperado.'
        : 'Base de clientes atualizada.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Não foi possível importar.');
    } finally { setBusy(false); }
  }

  async function saved() {
    await loadClients();
    setCreating(false);
    setEditing(null);
    setMessage('Cliente salvo e lista atualizada.');
  }

  const issues = batch?.issues ?? preview?.issues ?? [];
  const accessDenied = !loading && identity !== null && !canManage && !canImport;

  return <ScrapShell>
    <p className="seller-kicker">GESTÃO DE CLIENTES</p>
    <h1>Base de clientes</h1>
    <p>A planilha autorizada pela Gestão Comercial ou pelo Administrativo continua sendo a fonte oficial.</p>

    {loading && <p className="seller-notice" role="status">Carregando clientes…</p>}
    {accessDenied && <p className="seller-notice" role="alert">Seu perfil não tem acesso à gestão de clientes.</p>}
    {message && !accessDenied && <p className="seller-notice" role="status">{message}</p>}

    {canManage && !creating && !editing && <button
      type="button"
      className="seller-button seller-primary"
      onClick={() => { setCreating(true); setMessage(''); }}
    >Novo cliente</button>}

    {canManage && (creating || editing) && <ClientMaintenanceForm
      client={editing}
      sellers={sellers}
      onCancel={() => { setCreating(false); setEditing(null); }}
      onEditExisting={(current) => { setEditing(current); setCreating(false); setMessage(''); }}
      onSaved={saved}
    />}

    {canImport && <section aria-labelledby="client-import-title">
      <h2 id="client-import-title">Importar planilha oficial</h2>
      <p>Valide a planilha antes de atualizar clientes e carteiras. Clientes ausentes no arquivo não serão alterados.</p>
      <a className="seller-button seller-secondary" href="/api/v1/client-imports/template">Baixar modelo Excel</a>
      <div className="seller-stock-card seller-stock-form">
        <label>Planilha Excel<input
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={(event) => {
            setFile(event.target.files?.[0] ?? null);
            setPreview(null); setBatch(null);
          }}
          disabled={busy}
        /></label>
        {file && <p>Arquivo selecionado: <strong>{file.name}</strong></p>}
        <div className="seller-evidence-actions">
          <button type="button" className="seller-button seller-secondary" onClick={() => void validate()} disabled={busy || !file}>Validar</button>
          <button type="button" className="seller-button seller-primary" onClick={() => void execute()} disabled={busy || !file}>{busy ? 'Processando…' : 'Importar linhas válidas'}</button>
        </div>
      </div>
      {(preview || batch) && <section aria-labelledby="client-import-summary">
        <h3 id="client-import-summary">Resultado</h3>
        <p>Total: {preview?.totalCount ?? batch?.totalCount} · Aceitas: {preview?.acceptedCount ?? batch?.acceptedCount} · Rejeitadas: {preview?.rejectedCount ?? batch?.rejectedCount}</p>
        {batch && <p>Lote: <code>{batch.id}</code></p>}
        {issues.length > 0 && <ul className="seller-stop-list">{issues.map((item, index) => <li key={`${item.rowNumber}-${item.code}-${index}`} className="seller-stock-card"><strong>Linha {item.rowNumber}: {item.code}</strong><p>{item.message}</p></li>)}</ul>}
      </section>}
    </section>}

    {!loading && !accessDenied && <section aria-labelledby="client-list">
      <h2 id="client-list">Clientes cadastrados</h2>
      {clients.length === 0 && <p>Nenhum cliente encontrado na sua abrangência.</p>}
      <ul className="seller-stop-list">{clients.map((client) => <li className="seller-stock-card" key={client.id}>
        <h3>{client.name}</h3>
        <p>{client.externalReference} · {client.status === 'active' ? 'Ativo' : 'Inativo'} · versão {client.version}</p>
        <p>{client.address}</p>
        <p>Vendedor: {client.sellerEmail ?? 'Sem carteira'}{client.portfolioReference ? ` · ${client.portfolioReference}` : ''}</p>
        {canManage && <button
          type="button"
          className="seller-button seller-secondary"
          onClick={() => { setEditing(client); setCreating(false); setMessage(''); }}
        >Editar cliente</button>}
      </li>)}</ul>
    </section>}
  </ScrapShell>;
}
