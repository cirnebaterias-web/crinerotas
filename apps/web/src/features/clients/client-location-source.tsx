import type { ClientGoogleLocation } from '@cirne/contracts';

/** Imported reference only. Never renders observed GPS or claims field validation. */
export function ClientLocationSource({ location }: { location?: ClientGoogleLocation | null }) {
  if (!location) return <p className="seller-muted">Referência Google não disponível nesta versão do cadastro.</p>;
  return <div className="client-location-source">
    <p>Endereço Google: {location.address ?? 'Não informado'}</p>
    <p>Place ID: {location.placeId ? 'Informado na fonte' : 'Não informado'} · Status geo: {location.status ?? 'Não informado'} · Precisão Google: {location.precision ?? 'Não informada'}</p>
    <p className="seller-muted">Referência da planilha, ainda não validada em campo. O GPS da visita será guardado separadamente para conferência.</p>
  </div>;
}
