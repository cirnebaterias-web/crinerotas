'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  administrationPath, administrationSnapshotSchema, administrationUserPath, mePath,
  administrationUserPasswordPath, createAdministrationUserResultSchema, meResponseSchema,
  resetAdministrationPasswordResultSchema, updateAdministrationUserResultSchema,
  type AdministrationRoleCode, type AdministrationSnapshot, type AdministrationUser, type MeResponse,
} from '@cirne/contracts';
import { scrapRequest, ScrapRequestError } from '../scrap/scrap-ui';
import {
  administrationRoleLabels, filterAdministrationUsers, replaceAdministrationUser,
} from './administration-state';

type Draft = { status: AdministrationUser['status']; roles: AdministrationRoleCode[];
  sellerScopeIds: string[]; reason: string };
type CreateDraft = { displayName: string; email: string; password: string;
  roles: AdministrationRoleCode[]; reason: string };

const categoryLabels: Record<string, string> = {
  competitor: 'Concorrentes', technology: 'Tecnologias', condition: 'Condições',
  unavailable_reason: 'Motivos de indisponibilidade',
};

function draftFrom(user: AdministrationUser): Draft {
  return { status: user.status, roles: [...user.roles], sellerScopeIds: [...user.sellerScopeIds], reason: '' };
}
function formatDate(value: string | null) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
}
function temporaryPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
  return [...crypto.getRandomValues(new Uint32Array(18))]
    .map((value) => alphabet[value % alphabet.length]).join('');
}
async function loadWorkspace() {
  const [rawIdentity, rawSnapshot] = await Promise.all([scrapRequest(mePath), scrapRequest(administrationPath)]);
  return { identity: meResponseSchema.parse(rawIdentity), snapshot: administrationSnapshotSchema.parse(rawSnapshot) };
}

export function AdministrationWorkspace() {
  const [identity, setIdentity] = useState<MeResponse | null>(null);
  const [snapshot, setSnapshot] = useState<AdministrationSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [creating, setCreating] = useState(false);
  const [createDraft, setCreateDraft] = useState<CreateDraft>({ displayName: '', email: '',
    password: '', roles: ['seller'], reason: '' });
  const [temporary, setTemporary] = useState('');

  useEffect(() => {
    let active = true;
    void loadWorkspace().then((loaded) => {
      if (!active) return;
      setIdentity(loaded.identity); setSnapshot(loaded.snapshot);
      const first = loaded.snapshot.users.find((user) => user.id !== loaded.identity.id)
        ?? loaded.snapshot.users[0] ?? null;
      setSelectedId(first?.id ?? null); setDraft(first ? draftFrom(first) : null);
    }).catch((error) => {
      if (active) setNotice(error instanceof Error ? error.message : 'Não foi possível abrir a administração.');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const selected = snapshot?.users.find((user) => user.id === selectedId) ?? null;
  const visibleUsers = useMemo(() => filterAdministrationUsers(snapshot?.users ?? [], query), [snapshot, query]);
  const sellers = useMemo(() => {
    const existingScopeIds = new Set(draft?.sellerScopeIds ?? []);
    return (snapshot?.users ?? []).filter((user) => user.roles.includes('seller') &&
      (user.status === 'active' || existingScopeIds.has(user.id)));
  }, [draft?.sellerScopeIds, snapshot]);
  const parameterGroups = useMemo(() => {
    const groups = new Map<string, NonNullable<AdministrationSnapshot['parameters']['current']>['values']>();
    for (const value of snapshot?.parameters.current?.values ?? []) {
      groups.set(value.category, [...(groups.get(value.category) ?? []), value]);
    }
    return [...groups.entries()];
  }, [snapshot]);

  function selectUser(user: AdministrationUser) {
    setSelectedId(user.id); setDraft(draftFrom(user)); setNotice('');
  }
  function toggleRole(role: AdministrationRoleCode) {
    if (!draft) return;
    const roles = draft.roles.includes(role) ? draft.roles.filter((item) => item !== role) : [...draft.roles, role];
    setDraft({ ...draft, roles, sellerScopeIds: roles.includes('manager') ? draft.sellerScopeIds : [] });
  }
  function toggleSellerScope(sellerId: string) {
    if (!draft) return;
    setDraft({ ...draft, sellerScopeIds: draft.sellerScopeIds.includes(sellerId)
      ? draft.sellerScopeIds.filter((id) => id !== sellerId) : [...draft.sellerScopeIds, sellerId] });
  }
  async function reloadAfterConflict() {
    const loaded = await loadWorkspace();
    setIdentity(loaded.identity); setSnapshot(loaded.snapshot);
    const current = loaded.snapshot.users.find((user) => user.id === selectedId) ?? null;
    setDraft(current ? draftFrom(current) : null);
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!selected || !draft || selected.id === identity?.id || draft.roles.length === 0 || draft.reason.trim().length < 10) {
      setNotice('Selecione ao menos um papel e informe um motivo com 10 caracteres ou mais.'); return;
    }
    setBusy(true); setNotice('');
    try {
      const raw = await scrapRequest(administrationUserPath(selected.id), {
        method: 'PUT', headers: { 'content-type': 'application/json', 'x-csrf-token': 'cirne-route-v1' },
        body: JSON.stringify({ schemaVersion: 1, expectedUpdatedAt: selected.updatedAt,
          status: draft.status, roles: draft.roles, sellerScopeIds: draft.sellerScopeIds,
          reason: draft.reason.trim(), idempotencyKey: crypto.randomUUID() }),
      });
      const result = updateAdministrationUserResultSchema.parse(raw);
      setSnapshot((current) => current ? { ...current, users: replaceAdministrationUser(current.users, result.user) } : current);
      setDraft(draftFrom(result.user));
      setNotice(result.replayed ? 'Alteração anterior recuperada com segurança.' : 'Acesso atualizado e auditado.');
    } catch (error) {
      if (error instanceof ScrapRequestError && error.status === 409) {
        try { await reloadAfterConflict(); } catch { /* Keep the last confirmed snapshot. */ }
        setNotice('Outro administrador alterou este usuário. Os dados foram recarregados; revise antes de salvar.');
      } else {
        setNotice(error instanceof Error ? error.message : 'Não foi possível salvar. O último estado confirmado foi mantido.');
      }
    } finally { setBusy(false); }
  }

  async function createAccess(event: FormEvent) {
    event.preventDefault();
    if (!window.confirm(`Criar acesso para ${createDraft.displayName}?`)) return;
    setBusy(true); setNotice('');
    try {
      const raw = await scrapRequest(administrationPath, { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': 'cirne-route-v1' },
        body: JSON.stringify({ schemaVersion: 1, ...createDraft, idempotencyKey: crypto.randomUUID() }) });
      const result = createAdministrationUserResultSchema.parse(raw);
      setSnapshot((current) => current ? { ...current, users: [...current.users, result.user]
        .sort((a, b) => a.displayName.localeCompare(b.displayName, 'pt-BR')) } : current);
      setTemporary(createDraft.password); setCreating(false); selectUser(result.user);
      setCreateDraft({ displayName: '', email: '', password: '', roles: ['seller'], reason: '' });
      setNotice('Acesso criado. Copie a senha temporária agora; ela não será exibida novamente.');
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Não foi possível criar o acesso.'); }
    finally { setBusy(false); }
  }
  async function resetPassword() {
    if (!selected || !draft || selected.id === identity?.id || draft.reason.trim().length < 10) {
      setNotice('Informe o motivo com 10 caracteres ou mais antes de redefinir a senha.'); return;
    }
    const password = temporaryPassword();
    if (!window.confirm(`Redefinir a senha de ${selected.displayName}?`)) return;
    setBusy(true); setNotice('');
    try {
      const raw = await scrapRequest(administrationUserPasswordPath(selected.id), { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': 'cirne-route-v1' },
        body: JSON.stringify({ schemaVersion: 1, password, reason: draft.reason.trim(),
          idempotencyKey: crypto.randomUUID() }) });
      resetAdministrationPasswordResultSchema.parse(raw); setTemporary(password);
      setNotice('Senha redefinida. Copie a senha temporária agora; ela não será exibida novamente.');
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Não foi possível redefinir a senha.'); }
    finally { setBusy(false); }
  }

  if (loading) return <main className="administration-page"><p role="status">Carregando administração…</p></main>;
  if (!snapshot || !identity) return <main className="administration-page"><h1>Administração</h1><p className="administration-alert" role="alert">{notice || 'Seu perfil não tem acesso à administração.'}</p></main>;

  const activeCount = snapshot.users.filter((user) => user.status === 'active').length;
  const ownAccount = selected?.id === identity.id;
  return <main className="administration-page">
    <header className="administration-heading"><div><p className="manager-eyebrow">CONTROLE DE ACESSO</p><h1>Administração</h1>
      <p>Gerencie perfis já provisionados e consulte os parâmetros vigentes do piloto.</p></div>
      <dl><div><dt>Usuários</dt><dd>{snapshot.users.length}</dd></div><div><dt>Ativos</dt><dd>{activeCount}</dd></div>
        <div><dt>Bloqueados</dt><dd>{snapshot.users.length - activeCount}</dd></div></dl></header>
    {notice && <p className="administration-alert" role="status">{notice}</p>}
    {temporary && <aside className="administration-credential" role="status"><strong>Senha temporária (exibida uma vez)</strong>
      <code>{temporary}</code><button type="button" onClick={() => void navigator.clipboard.writeText(temporary)}>Copiar senha</button>
      <button type="button" onClick={() => setTemporary('')}>Ocultar</button></aside>}
    <div className="administration-create-action"><button className="seller-button seller-primary" type="button"
      onClick={() => { setCreating((value) => !value); setTemporary(''); }}>{creating ? 'Cancelar criação' : 'Criar acesso'}</button></div>
    {creating && <form className="administration-create" onSubmit={createAccess}>
      <h2>Novo acesso</h2><label>Nome completo<input required minLength={2} maxLength={120} value={createDraft.displayName}
        onChange={(event) => setCreateDraft({ ...createDraft, displayName: event.target.value })} /></label>
      <label>Email<input required type="email" value={createDraft.email}
        onChange={(event) => setCreateDraft({ ...createDraft, email: event.target.value })} /></label>
      <label>Senha inicial<input required type="password" minLength={12} maxLength={128} value={createDraft.password}
        onChange={(event) => setCreateDraft({ ...createDraft, password: event.target.value })} />
        <button type="button" onClick={() => setCreateDraft({ ...createDraft, password: temporaryPassword() })}>Gerar senha segura</button></label>
      <fieldset><legend>Papéis</legend>{snapshot.roles.map((role) => <label key={role.code}><input type="checkbox"
        checked={createDraft.roles.includes(role.code)} onChange={() => setCreateDraft({ ...createDraft, roles:
          createDraft.roles.includes(role.code) ? createDraft.roles.filter((item) => item !== role.code) : [...createDraft.roles, role.code] })} /> {role.name}</label>)}</fieldset>
      <label>Motivo<input required minLength={10} maxLength={500} value={createDraft.reason}
        onChange={(event) => setCreateDraft({ ...createDraft, reason: event.target.value })} /></label>
      <button className="seller-button seller-primary" disabled={busy || createDraft.roles.length === 0}>{busy ? 'Criando…' : 'Criar acesso'}</button>
    </form>}
    <section className="administration-access" aria-labelledby="access-title">
      <div className="administration-directory">
        <div className="administration-section-heading"><div><h2 id="access-title">Usuários e acessos</h2><p>{visibleUsers.length} exibido(s)</p></div>
          <label>Buscar usuário<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Nome, papel ou status" /></label></div>
        <ul>{visibleUsers.map((user) => <li key={user.id}><button type="button" data-selected={user.id === selectedId} onClick={() => selectUser(user)}>
          <span><strong>{user.displayName}</strong><small>{user.roles.map((role) => administrationRoleLabels[role]).join(' · ')}</small></span>
          <span className={`administration-user-status status-${user.status}`}>{user.status === 'active' ? 'Ativo' : 'Bloqueado'}</span>
        </button></li>)}</ul>
        {visibleUsers.length === 0 && <p className="administration-empty">Nenhum usuário corresponde à busca.</p>}
      </div>
      <aside className="administration-editor" aria-labelledby="editor-title">
        {!selected || !draft ? <p>Selecione um usuário para inspecionar.</p> : <form onSubmit={save}>
          <header><div><p className="manager-eyebrow">PERFIL SELECIONADO</p><h2 id="editor-title">{selected.displayName}</h2></div>
            <span className={`administration-user-status status-${selected.status}`}>{selected.status === 'active' ? 'Ativo' : 'Bloqueado'}</span></header>
          <p className="administration-meta">Atualizado em {formatDate(selected.updatedAt)}</p>
          <p className="administration-meta"><strong>Email:</strong> {selected.auth?.email ?? 'Identidade Auth não localizada'}<br />
            <strong>Último acesso:</strong> {formatDate(selected.auth?.lastSignInAt ?? null)}</p>
          {ownAccount && <p className="administration-guard">Sua própria conta pode ser consultada, mas não alterada aqui.</p>}
          <fieldset disabled={busy || ownAccount}><legend>Situação do acesso</legend>
            <label><input type="radio" name="status" checked={draft.status === 'active'} onChange={() => setDraft({ ...draft, status: 'active' })} /> Ativo</label>
            <label><input type="radio" name="status" checked={draft.status === 'inactive'} onChange={() => setDraft({ ...draft, status: 'inactive' })} /> Bloqueado</label>
          </fieldset>
          <fieldset disabled={busy || ownAccount}><legend>Papéis</legend>{snapshot.roles.map((role) => <label key={role.code}>
            <input type="checkbox" checked={draft.roles.includes(role.code)} onChange={() => toggleRole(role.code)} /> {role.name}</label>)}</fieldset>
          {draft.roles.includes('manager') && <fieldset className="administration-scopes" disabled={busy || ownAccount}><legend>Vendedores sob gestão</legend>
            {sellers.length === 0 ? <p>Nenhum Vendedor ativo disponível.</p> : sellers.map((seller) => <label key={seller.id}>
              <input type="checkbox" checked={draft.sellerScopeIds.includes(seller.id)} onChange={() => toggleSellerScope(seller.id)} /> {seller.displayName}{seller.status === 'inactive' ? ' (bloqueado)' : ''}</label>)}</fieldset>}
          <label className="administration-reason">Motivo da alteração<textarea value={draft.reason} disabled={busy || ownAccount}
            onChange={(event) => setDraft({ ...draft, reason: event.target.value })} minLength={10} maxLength={500} rows={3}
            placeholder="Registre a justificativa para auditoria" /></label>
          {selected.lastAdministrativeChange && <p className="administration-history"><strong>Última mudança:</strong> {selected.lastAdministrativeChange.reason}<br /><small>{formatDate(selected.lastAdministrativeChange.occurredAt)}</small></p>}
          <button className="seller-button seller-primary" type="submit" disabled={busy || ownAccount}>{busy ? 'Salvando…' : 'Salvar acesso'}</button>
          <button className="seller-button" type="button" disabled={busy || ownAccount || selected.status !== 'active'}
            onClick={() => void resetPassword()}>Redefinir senha</button>
        </form>}
      </aside>
    </section>
    <section className="administration-parameters" aria-labelledby="parameters-title">
      <div className="administration-section-heading"><div><p className="manager-eyebrow">SOMENTE LEITURA</p><h2 id="parameters-title">Parâmetros publicados</h2>
        <p>Alterações bloqueadas até a aprovação formal das decisões de negócio.</p></div><span className="administration-lock">AB-02 · AB-03 · AB-09</span></div>
      {snapshot.parameters.current ? <><p className="administration-parameter-version">Versão {snapshot.parameters.current.version} · válida desde {formatDate(snapshot.parameters.current.validFrom)}</p>
        <div className="administration-parameter-groups">{parameterGroups.map(([category, values]) => <article key={category}><h3>{categoryLabels[category] ?? category}</h3>
          <ul>{values.map((value) => <li key={value.id}><span>{value.label}</span><code>{value.code}</code></li>)}</ul></article>)}</div></>
        : <p className="administration-empty">Nenhum conjunto de parâmetros está publicado.</p>}
    </section>
  </main>;
}
