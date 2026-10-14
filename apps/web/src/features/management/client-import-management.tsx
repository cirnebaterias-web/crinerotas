'use client';
import { useCallback, useEffect, useState } from 'react';
import {
  clientImportBatchSchema, clientImportPreviewSchema, clientListResponseSchema,
  clientImportsPath, clientImportsValidatePath, clientsPath,
  type ClientImportBatch, type ClientImportPreview, type ImportedClient,
} from '@cirne/contracts';
import { ScrapShell, scrapRequest } from '@/features/scrap/scrap-ui';

async function sendFile(path: string, file: File) {
  const form = new FormData(); form.set('file', file);
  return scrapRequest(path, { method: 'POST', headers: { 'x-csrf-token': 'cirne-route-v1' }, body: form });
}
export function ClientImportManagement() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ClientImportPreview | null>(null);
  const [batch, setBatch] = useState<ClientImportBatch | null>(null);
  const [clients, setClients] = useState<ImportedClient[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const loadClients = useCallback(async () => {
    setClients(clientListResponseSchema.parse(await scrapRequest(clientsPath)).clients);
  }, []);
  useEffect(() => { void loadClients().catch((error) => setMessage(error instanceof Error ? error.message : 'Não foi possível consultar clientes.')); }, [loadClients]);
  async function validate() {
    if (!file) { setMessage('Selecione uma planilha .xlsx.'); return; }
    setBusy(true); setMessage(''); setBatch(null);
    try {
      const result = clientImportPreviewSchema.parse(await sendFile(clientImportsValidatePath, file));
      setPreview(result);
      setMessage(result.rejectedCount === 0 ? 'Planilha válida e pronta para importar.' : 'Revise as rejeições ou importe somente as linhas aceitas.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Não foi possível validar.'); }
    finally { setBusy(false); }
  }
  async function execute() {
    if (!file) { setMessage('Selecione uma planilha .xlsx.'); return; }
    setBusy(true); setMessage('');
    try {
      const result = clientImportBatchSchema.parse(await sendFile(clientImportsPath, file));
      setBatch(result); setPreview(null); await loadClients();
      setMessage(result.replayed ? 'Este conteúdo já havia sido importado; o resultado anterior foi recuperado.' : 'Base de clientes atualizada.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Não foi possível importar.'); }
    finally { setBusy(false); }
  }
  const issues = batch?.issues ?? preview?.issues ?? [];
  return <ScrapShell>
    <p className="seller-kicker">GESTÃO DE CLIENTES</p><h1>Importar base de clientes</h1>
    <p>Valide a planilha antes de atualizar clientes e carteiras. Clientes ausentes no arquivo não serão alterados.</p>
    <a className="seller-button seller-secondary" href="/api/v1/client-imports/template">Baixar modelo Excel</a>
    <div className="seller-stock-card">
      <label>Planilha Excel<input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        onChange={(event) => { setFile(event.target.files?.[0] ?? null); setPreview(null); setBatch(null); }} disabled={busy} /></label>
      {file && <p>Arquivo selecionado: <strong>{file.name}</strong></p>}
      <button type="button" className="seller-button seller-secondary" onClick={() => void validate()} disabled={busy || !file}>Validar</button>
      <button type="button" className="seller-button seller-primary" onClick={() => void execute()} disabled={busy || !file}>{busy ? 'Processando…' : 'Importar linhas válidas'}</button>
    </div>
    {message && <p className="seller-notice" role="status">{message}</p>}
    {(preview || batch) && <section aria-labelledby="client-import-summary"><h2 id="client-import-summary">Resultado</h2>
      <p>Total: {preview?.totalCount ?? batch?.totalCount} · Aceitas: {preview?.acceptedCount ?? batch?.acceptedCount} · Rejeitadas: {preview?.rejectedCount ?? batch?.rejectedCount}</p>
      {batch && <p>Lote: <code>{batch.id}</code></p>}
      {issues.length > 0 && <ul className="seller-stop-list">{issues.map((item, index) => <li key={`${item.rowNumber}-${item.code}-${index}`} className="seller-stock-card"><strong>Linha {item.rowNumber}: {item.code}</strong><p>{item.message}</p></li>)}</ul>}
    </section>}
    <section aria-labelledby="client-list"><h2 id="client-list">Clientes cadastrados</h2>
      <ul className="seller-stop-list">{clients.map((client) => <li className="seller-stock-card" key={client.id}>
        <h3>{client.name}</h3><p>{client.externalReference} · {client.status === 'active' ? 'Ativo' : 'Arquivado'}</p>
        <p>{client.address}</p><p>Vendedor: {client.sellerEmail ?? 'Sem carteira'}{client.portfolioReference ? ` · ${client.portfolioReference}` : ''}</p>
      </li>)}</ul>
    </section>
  </ScrapShell>;
}
