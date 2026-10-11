'use client';

import { useEffect, useState, type FormEvent } from 'react';
import {
  commercialActionListSchema, commercialActionsPath, saveCommercialActionRequestSchema,
  type CommercialAction, type SaveCommercialActionRequest,
} from '@cirne/contracts';
import { Brand } from '@/features/auth/brand';

const headers = { 'content-type': 'application/json', 'x-csrf-token': 'cirne-route-v1' };

function blank(): SaveCommercialActionRequest {
  const today = new Date().toISOString().slice(0, 10);
  return { title: '', description: '', validFrom: today, validUntil: today, active: true };
}

export function CommercialActionsManagement() {
  const [actions, setActions] = useState<CommercialAction[]>([]);
  const [form, setForm] = useState<SaveCommercialActionRequest>(blank);
  const [editingId, setEditingId] = useState<string>();
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState('');

  async function load() {
    setBusy(true);
    const response = await fetch(commercialActionsPath, { credentials: 'same-origin', cache: 'no-store' });
    if (response.status === 401 || response.status === 403) { window.location.replace('/login'); return; }
    if (!response.ok) throw new Error('Não foi possível carregar as ações.');
    setActions(commercialActionListSchema.parse(await response.json()).actions);
    setBusy(false);
  }
  useEffect(() => { void load().catch((error) => { setMessage(error.message); setBusy(false); }); }, []);

  async function submit(event: FormEvent) {
    event.preventDefault(); setMessage('');
    const parsed = saveCommercialActionRequestSchema.safeParse(form);
    if (!parsed.success) { setMessage(parsed.error.issues[0]?.message ?? 'Revise o cadastro.'); return; }
    setBusy(true);
    const response = await fetch(editingId ? `${commercialActionsPath}/${editingId}` : commercialActionsPath, {
      method: editingId ? 'PUT' : 'POST', credentials: 'same-origin', headers,
      body: JSON.stringify(parsed.data),
    });
    if (!response.ok) { setMessage('Não foi possível salvar a ação.'); setBusy(false); return; }
    setForm(blank()); setEditingId(undefined); setMessage('Ação salva com sucesso.'); await load();
  }

  function edit(action: CommercialAction) {
    setEditingId(action.id);
    setForm({ title: action.title, description: action.description, validFrom: action.validFrom,
      validUntil: action.validUntil, ...(action.bannerUrl ? { bannerUrl: action.bannerUrl } : {}), active: action.active });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  return <div className="seller-app seller-route-page">
    <header className="seller-topbar"><div className="seller-topbar-inner"><Brand /></div></header>
    <main className="seller-route-main"><div className="seller-visit-start manager-actions-page">
      <p className="seller-kicker">GESTÃO COMERCIAL</p><h1>Ações Heliar<span className="seller-heading-dot">.</span></h1>
      <p className="seller-muted">Cadastre o conteúdo que o vendedor deverá apresentar ao PDV durante a vigência.</p>
      <form className="manager-action-form" onSubmit={submit} aria-busy={busy}>
        <h2>{editingId ? 'Editar ação' : 'Nova ação'}</h2>
        <label>Título<input required maxLength={120} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
        <label>Descrição<textarea required rows={5} maxLength={1200} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
        <div className="seller-form-grid">
          <label>Início<input type="date" required value={form.validFrom} onChange={(e) => setForm({ ...form, validFrom: e.target.value })} /></label>
          <label>Término<input type="date" required value={form.validUntil} onChange={(e) => setForm({ ...form, validUntil: e.target.value })} /></label>
        </div>
        <label>URL do banner quadrado 1:1 (opcional)<input type="url" maxLength={1000} value={form.bannerUrl ?? ''}
          placeholder="https://..." onChange={(e) => setForm({ ...form, bannerUrl: e.target.value || undefined })} /></label>
        <label className="seller-action-confirm"><input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> Ação ativa</label>
        <div className="seller-evidence-actions">
          {editingId && <button type="button" className="seller-button seller-secondary" onClick={() => { setEditingId(undefined); setForm(blank()); }}>Cancelar</button>}
          <button className="seller-button seller-primary" disabled={busy}>{busy ? 'Salvando…' : 'Salvar ação'}</button>
        </div>
      </form>
      {message && <p className="seller-notice" role="status">{message}</p>}
      <section className="manager-action-list"><h2>Ações cadastradas</h2>
        {actions.length === 0 && !busy && <p>Nenhuma ação cadastrada.</p>}
        {actions.map((action) => <article className="seller-own-action-card" key={action.id}>
          <div className="seller-own-action-banner">{action.bannerUrl ? <img src={action.bannerUrl} alt="" /> : <span>H</span>}</div>
          <div><p className="seller-kicker">{action.active ? 'ATIVA' : 'INATIVA'} · {action.validFrom} a {action.validUntil}</p>
            <h3>{action.title}</h3><p>{action.description}</p>
            <button className="seller-button seller-secondary" onClick={() => edit(action)}>Editar</button></div>
        </article>)}
      </section>
    </div></main>
  </div>;
}
