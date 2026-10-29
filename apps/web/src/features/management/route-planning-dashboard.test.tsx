import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { RoutePlanningDashboard } from './route-planning-dashboard';

vi.mock('../scrap/scrap-ui', () => ({
  localDate: () => '2026-10-29',
  scrapRequest: vi.fn(),
  ScrapRequestError: class ScrapRequestError extends Error {},
}));

describe('route planning dashboard', () => {
  it('renders the desktop planning regions and accessible non-drag controls', () => {
    const html = renderToStaticMarkup(<RoutePlanningDashboard />);
    expect(html).toContain('Planejar rotas');
    expect(html).toContain('Clientes disponíveis');
    expect(html).toContain('Composição da rota');
    expect(html).toContain('Salvar e publicar');
    expect(html).toContain('Abrir Central do dia');
    expect(html).toContain('Data da rota');
    expect(html).toContain('Vendedor');
    expect(html).toContain('A rota ainda está vazia');
    expect(html).not.toContain('draggable');
  });
});
