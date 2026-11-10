import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { WeeklyRouteProposalDashboard } from './weekly-route-proposal-dashboard';

vi.mock('../scrap/scrap-ui', () => ({ scrapRequest: vi.fn() }));

describe('weekly route proposal dashboard', () => {
  it('explains manager approval and keeps generation explicit', () => {
    const html = renderToStaticMarkup(<WeeklyRouteProposalDashboard />);
    expect(html).toContain('Planejamento semanal de visitas');
    expect(html).toContain('sugestão por regras protege a rotina da carteira');
    expect(html).toContain('O vendedor só recebe após sua aprovação');
    expect(html).toContain('Abrir ou criar sugestão');
  });
});
