import type { CanonicalRoute, LocalVisitDraft } from '@cirne/contracts';

/** Keep original visits reachable without attaching them to a successor stop. */
export function SavedVisits({ route, drafts }: { route: CanonicalRoute; drafts: LocalVisitDraft[] }) {
  const currentStops = new Set(route.stops.map((stop) => stop.routeVersionStopId));
  const previous = drafts.filter((draft) => draft.deviceStartedAt && !currentStops.has(draft.routeVersionStopId));
  if (previous.length === 0) return null;

  return <section className="seller-saved-visits" aria-labelledby="saved-visits-title">
    <div className="seller-section-heading"><div>
      <h2 id="saved-visits-title">Visitas salvas de outras versões</h2>
      <p>A rota mudou. Estes atendimentos continuam vinculados à parada original.</p>
    </div></div>
    <ul className="seller-stop-list">{previous.map((draft) => <li key={draft.offlineId} className="seller-stop-card">
      <div className="seller-stop-info">
        <h3>{draft.client?.name ?? 'Atendimento salvo'}</h3>
        {draft.client?.address && <p>{draft.client.address}</p>}
        <p>{draft.persistenceState === 'synced' ? 'Sincronizada' : 'Salva no aparelho'}</p>
        <a className="seller-button seller-visit-action" href={`/visit/${draft.offlineId}?step=${draft.currentStep}`}>Continuar visita</a>
      </div>
    </li>)}</ul>
  </section>;
}
