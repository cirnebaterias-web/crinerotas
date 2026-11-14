import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AdditionalClientDialog } from './additional-client-dialog';
import { NonVisitWizard } from './non-visit-wizard';
import { ClientFieldProfileGate } from '../visits/client-field-profile-gate';
import { ClientClosurePrompt } from './client-closure-prompt';
import { projectOfflineNonVisit } from './route-model';

vi.mock('../../lib/seller-client', () => ({ sellerClient: {} }));

const id = '11111111-1111-4111-8111-111111111111';
const route = {
  schemaVersion: 2 as const, routeId: id, routeVersionId: id, versionNumber: 1,
  serviceDate: '2026-11-13', status: 'published' as const, publishedAt: '2026-11-13T12:00:00.000Z',
  executionVersion: 1, seller: { id, displayName: 'Vendedor' },
  stops: [{ routeVersionStopId: id, plannedOrder: 1, executionOrder: 1, priority: 1,
    status: 'pending' as const, executionVersion: 1, client: { id, externalReference: 'C-1',
      name: 'Cliente atual', address: 'Rua 1', latitude: '-5.8', longitude: '-35.2', portfolioReference: null } }],
};

describe('field outcome mobile components', () => {
  it('renders the portfolio search used to append a client to the route', () => {
    const html = renderToStaticMarkup(<AdditionalClientDialog route={route} deviceId={id}
      onClose={() => undefined} onAdded={async () => undefined} />);
    expect(html).toContain('Adicionar cliente');
    expect(html).toContain('Somente clientes ativos da sua carteira');
  });

  it('starts non-visit with an explicit reason and without starting a visit', () => {
    const html = renderToStaticMarkup(<NonVisitWizard stop={route.stops[0]!} deviceId={id}
      onCancel={() => undefined} onDone={async () => undefined} />);
    expect(html).toContain('Por que a visita não aconteceu?');
    expect(html).toContain('Selecione o motivo');
    expect(html).not.toContain('Iniciar visita');
  });

  it('blocks on the client profile lookup before presenting visit tasks', () => {
    const html = renderToStaticMarkup(<ClientFieldProfileGate clientId={id} clientName="Cliente sem perfil"
      deviceId={id} onReady={() => undefined} />);
    expect(html).toContain('Classifique este cliente');
    expect(html).toContain('Consultando cadastro');
    expect(html).toContain('Cliente encerrou as atividades');
  });

  it('keeps client closure separate from an already recorded non-visit', () => {
    const html = renderToStaticMarkup(<ClientClosurePrompt client={route.stops[0]!.client} deviceId={id}
      onCancel={() => undefined} onClosed={async () => undefined} />);
    expect(html).toContain('Este cliente encerrou as atividades?');
    expect(html).toContain('A não-visita já foi registrada');
    expect(html).toContain('Não baixar agora');
    expect(html).toContain('Confirmar encerramento');
  });

  it('projects a saved offline non-visit immediately without changing the other stops', () => {
    const second = { ...route.stops[0]!, routeVersionStopId: '22222222-2222-4222-8222-222222222222', plannedOrder: 2, executionOrder: 2 };
    const projected = projectOfflineNonVisit({ ...route, stops: [...route.stops, second] }, id);
    expect(projected.stops.map((stop) => stop.status)).toEqual(['not_visited', 'pending']);
    expect(projected.routeVersionId).toBe(route.routeVersionId);
  });
});
