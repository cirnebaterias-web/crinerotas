'use client';

import { ClientLocationSource } from '../clients/client-location-source';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
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
  type ClientListPagination,
  type ClientSeller,
  type ImportedClient,
  type MeResponse,
} from '@cirne/contracts';
import { ClientMaintenanceForm } from './client-maintenance-form';
import { ClientSheetSyncPanel } from './client-sheet-sync-panel';
import { ScrapShell, scrapRequest } from '@/features/scrap/scrap-ui';
import { ClientSalesDialog } from '@/features/clients/client-sales-dialog';
import { observeLocalAccessRevocation } from '@/lib/offline/access-revocation';

const clientPageSize = 25;
const initialPagination: ClientListPagination = {
  page: 1,
  pageSize: clientPageSize,
  totalCount: 0,
  totalPages: 0,
  hasPrevious: false,
  hasNext: false,
};

function clientListUrl(query: string, page: number) {
  const parameters = new URLSearchParams({ page: String(page), pageSize: String(clientPageSize) });
  if (query.trim()) parameters.set('q', query.trim());
  return `${clientsPath}?${parameters}`;
}

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
  const [salesClient, setSalesClient] = useState<ImportedClient | null>(null);
  const [loading, setLoading] = useState(true);
  const [clientsLoaded, setClientsLoaded] = useState(false);
  const [listBusy, setListBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [appliedQuery, setAppliedQuery] = useState('');
  const [pagination, setPagination] = useState<ClientListPagination>(initialPagination);
  const accessBlocked = useRef(false);

  const loadClients = useCallback(async (query: string, page: number) => {
    if (accessBlocked.current) return;
    const response = await scrapRequest(clientListUrl(query, page));
    if (accessBlocked.current) return;
    const result = clientListResponseSchema.parse(response);
    setClients(result.clients);
    setAppliedQuery(result.query);
    setPagination(result.pagination);
    setClientsLoaded(true);
    return result;
  }, []);

  useEffect(() => {
    let active = true;
    const stopObserving = observeLocalAccessRevocation(() => {
      active = false; accessBlocked.current = true;
      setIdentity(null); setClients([]); setSellers([]); setSalesClient(null);
      setEditing(null); setCreating(false); setClientsLoaded(false); setLoading(false);
      setBusy(false); setListBusy(false);
      setMessage('Seu acesso mudou. Entre novamente para consultar os clientes.');
    });
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
        const [clientResult, sellerResult] = await Promise.allSettled([
          scrapRequest(clientListUrl('', 1)),
          canManage ? scrapRequest(clientSellersPath) : Promise.resolve(null),
        ]);
        if (!active) return;
        const loadErrors: string[] = [];
        if (clientResult.status === 'fulfilled') {
          try {
            const clientList = clientListResponseSchema.parse(clientResult.value);
            setClients(clientList.clients);
            setAppliedQuery(clientList.query);
            setPagination(clientList.pagination);
            setClientsLoaded(true);
          } catch (error) {
            loadErrors.push(error instanceof Error ? error.message : 'Não foi possível consultar clientes.');
          }
        } else {
          loadErrors.push(clientResult.reason instanceof Error
            ? clientResult.reason.message : 'Não foi possível consultar clientes.');
        }
        if (sellerResult.status === 'fulfilled' && sellerResult.value) {
          try {
            setSellers(clientSellerListResponseSchema.parse(sellerResult.value).sellers);
          } catch (error) {
            loadErrors.push(error instanceof Error ? error.message : 'Não foi possível consultar vendedores.');
          }
        } else if (sellerResult.status === 'rejected') {
          loadErrors.push(sellerResult.reason instanceof Error
            ? sellerResult.reason.message : 'Não foi possível consultar vendedores.');
        }
        if (loadErrors.length > 0) {
          setMessage([...new Set(loadErrors)].join(' '));
        }
      } catch (error) {
        if (active) setMessage(error instanceof Error ? error.message : 'Não foi possível consultar clientes.');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; stopObserving(); };
  }, []);

  const canManage = identity?.capabilities.includes('clients.manage') ?? false;
  const canImport = identity?.capabilities.includes('clients.import') ?? false;
  const canReadSales = identity?.capabilities.includes('sales.read_client') ?? false;

  async function validate() {
    if (accessBlocked.current) return;
    if (!file) { setMessage('Selecione uma planilha .xlsx.'); return; }
    setBusy(true); setMessage(''); setBatch(null);
    try {
      const result = clientImportPreviewSchema.parse(await sendFile(clientImportsValidatePath, file));
      if (accessBlocked.current) return;
      setPreview(result);
      setMessage(result.rejectedCount === 0
        ? 'Planilha válida e pronta para importar.'
        : 'Revise as rejeições ou importe somente as linhas aceitas.');
    } catch (error) {
      if (accessBlocked.current) return;
      setMessage(error instanceof Error ? error.message : 'Não foi possível validar.');
    } finally { if (!accessBlocked.current) setBusy(false); }
  }

  async function execute() {
    if (accessBlocked.current) return;
    if (!file) { setMessage('Selecione uma planilha .xlsx.'); return; }
    setBusy(true); setMessage('');
    try {
      const result = clientImportBatchSchema.parse(await sendFile(clientImportsPath, file));
      if (accessBlocked.current) return;
      setBatch(result); setPreview(null);
      const successMessage = result.replayed
        ? 'Este conteúdo já havia sido importado; o resultado anterior foi recuperado.'
        : 'Base de clientes atualizada.';
      try {
        await loadClients(appliedQuery, 1);
        if (accessBlocked.current) return;
        setMessage(successMessage);
      } catch {
        if (accessBlocked.current) return;
        setMessage(`${successMessage} A lista não pôde ser atualizada. Atualize a página para consultar o estado mais recente.`);
      }
    } catch (error) {
      if (accessBlocked.current) return;
      setMessage(error instanceof Error ? error.message : 'Não foi possível importar.');
    } finally { if (!accessBlocked.current) setBusy(false); }
  }

  async function saved(client: ClientDetail) {
    if (accessBlocked.current) return;
    setSearchInput(client.externalReference);
    setCreating(false);
    setEditing(null);
    try {
      await loadClients(client.externalReference, 1);
      if (accessBlocked.current) return;
      setMessage('Cliente salvo e lista atualizada.');
    } catch {
      if (accessBlocked.current) return;
      setMessage('Cliente salvo. A lista não pôde ser atualizada. Atualize a página para consultar o estado mais recente.');
    }
  }

  async function searchClients(event: FormEvent) {
    event.preventDefault();
    if (accessBlocked.current) return;
    setListBusy(true); setMessage('');
    try {
      await loadClients(searchInput, 1);
    } catch (error) {
      if (accessBlocked.current) return;
      setMessage(error instanceof Error ? error.message : 'Não foi possível buscar clientes.');
    } finally { if (!accessBlocked.current) setListBusy(false); }
  }

  async function clearSearch() {
    if (accessBlocked.current) return;
    setSearchInput(''); setListBusy(true); setMessage('');
    try {
      await loadClients('', 1);
    } catch (error) {
      if (accessBlocked.current) return;
      setMessage(error instanceof Error ? error.message : 'Não foi possível limpar a busca.');
    } finally { if (!accessBlocked.current) setListBusy(false); }
  }

  async function showPage(page: number) {
    if (accessBlocked.current) return;
    setListBusy(true); setMessage('');
    try {
      await loadClients(appliedQuery, page);
    } catch (error) {
      if (accessBlocked.current) return;
      setMessage(error instanceof Error ? error.message : 'Não foi possível carregar a página.');
    } finally { if (!accessBlocked.current) setListBusy(false); }
  }

  async function retryInitialClients() {
    if (accessBlocked.current) return;
    setListBusy(true); setMessage('');
    try {
      await loadClients('', 1);
      if (accessBlocked.current) return;
      setSearchInput('');
      setMessage('Clientes carregados.');
    } catch (error) {
      if (accessBlocked.current) return;
      setMessage(error instanceof Error ? error.message : 'Não foi possível consultar clientes.');
    } finally { if (!accessBlocked.current) setListBusy(false); }
  }

  const issues = batch?.issues ?? preview?.issues ?? [];
  const accessDenied = !loading && identity !== null && !canManage && !canImport;

  return <ScrapShell>
    <p className="seller-kicker">GESTÃO DE CLIENTES</p>
    <h1>Base de clientes</h1>
    <p>A planilha autorizada pela Gestão Comercial ou pelo Administrativo continua sendo a fonte oficial.</p>
    {(canManage || canImport) && <nav className="seller-evidence-actions" aria-label="Atalhos da base de clientes">
      <a className="seller-button seller-secondary" href="#client-list">{canReadSales ? 'Consultar clientes e mini CRM' : 'Consultar clientes'}</a>
      {canImport && <a className="seller-button seller-secondary" href="#client-base-updates">Atualizar ou importar base</a>}
    </nav>}

    {loading && <p className="seller-notice" role="status">Carregando clientes…</p>}
    {accessDenied && <p className="seller-notice" role="alert">Seu perfil não tem acesso à gestão de clientes.</p>}
    {message && !accessDenied && <p className="seller-notice" role="status">{message}</p>}
    {!loading && !clientsLoaded && identity !== null && !accessDenied && <button
      type="button"
      className="seller-button seller-secondary"
      disabled={listBusy}
      onClick={() => void retryInitialClients()}
    >{listBusy ? 'Tentando novamente…' : 'Tentar carregar clientes novamente'}</button>}

    {canManage && !creating && !editing && <button
      type="button"
      className="seller-button seller-primary"
      onClick={() => { setCreating(true); setMessage(''); }}
    >Novo cliente</button>}

    {canManage && (creating || editing) && <ClientMaintenanceForm
      client={editing}
      sellers={sellers}
      onCancel={() => { setCreating(false); setEditing(null); }}
      onEditExisting={(current) => { if (!accessBlocked.current) { setEditing(current); setCreating(false); setMessage(''); } }}
      onSaved={saved}
    />}

    {!loading && clientsLoaded && !accessDenied && <section aria-labelledby="client-list" aria-busy={listBusy}>
      <h2 id="client-list">Clientes cadastrados</h2>
      {canReadSales && <p>Abra o mini CRM de um cliente para consultar compras, gráficos, produtos e histórico.</p>}
      <form className="seller-stock-card seller-stock-form" role="search" onSubmit={searchClients}>
        <label htmlFor="client-search">Pesquisar clientes</label>
        <input
          id="client-search"
          type="search"
          placeholder="Nome, referência, endereço ou carteira"
          maxLength={120}
          value={searchInput}
          disabled={listBusy}
          onChange={(event) => setSearchInput(event.target.value)}
        />
        <div className="seller-evidence-actions">
          <button className="seller-button seller-primary" disabled={listBusy}>
            {listBusy ? 'Buscando…' : 'Buscar clientes'}
          </button>
          {appliedQuery && <button
            type="button"
            className="seller-button seller-secondary"
            disabled={listBusy}
            onClick={() => void clearSearch()}
          >Limpar busca</button>}
        </div>
      </form>
      <p role="status">
        {pagination.totalCount} {pagination.totalCount === 1 ? 'cliente encontrado' : 'clientes encontrados'}
        {appliedQuery ? ` para “${appliedQuery}”` : ''}. Página {pagination.page} de {Math.max(pagination.totalPages, 1)}.
      </p>
      {clients.length === 0 && <p>Nenhum cliente encontrado na sua abrangência para esta busca.</p>}
      <ul className="seller-stop-list">{clients.map((client) => <li className="seller-stock-card" key={client.id}>
        <h3 aria-label={client.name}>{canReadSales
          ? <button type="button" className="client-sales-trigger" aria-label={`Consultar compras de ${client.name}`} onClick={() => setSalesClient(client)}>{client.name}</button>
          : client.name}</h3>
        <p>{client.externalReference} · {client.status === 'active' ? 'Ativo' : 'Inativo'} · versão {client.version}</p>
        <p>{client.address}</p>
        <ClientLocationSource location={client.googleLocation} />
        <p>Vendedor: {client.sellerEmail ?? 'Sem carteira'}{client.portfolioReference ? ` · ${client.portfolioReference}` : ''}</p>
        <div className="seller-evidence-actions">
        {canReadSales && <button type="button" className="seller-button seller-primary" aria-label={`Ver mini CRM de ${client.name}`} onClick={() => setSalesClient(client)}>Ver mini CRM</button>}
        {canManage && <button
          type="button"
          className="seller-button seller-secondary"
          onClick={() => { setEditing(client); setCreating(false); setMessage(''); }}
        >Editar cliente</button>}
        </div>
      </li>)}</ul>
      {(pagination.hasPrevious || pagination.hasNext) && <nav className="seller-evidence-actions" aria-label="Paginação de clientes">
        <button
          type="button"
          className="seller-button seller-secondary"
          disabled={listBusy || !pagination.hasPrevious}
          onClick={() => void showPage(pagination.page - 1)}
        >Página anterior</button>
        <button
          type="button"
          className="seller-button seller-secondary"
          disabled={listBusy || !pagination.hasNext}
          onClick={() => void showPage(pagination.page + 1)}
        >Próxima página</button>
      </nav>}
    </section>}

    {canImport && <div id="client-base-updates">
      <ClientSheetSyncPanel onUpdated={() => loadClients(appliedQuery, 1)} />
      <section aria-labelledby="client-import-title">
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
      </section>
    </div>}
    {salesClient && canReadSales && <ClientSalesDialog key={salesClient.id} client={salesClient} onClose={() => setSalesClient(null)} />}
  </ScrapShell>;
}
