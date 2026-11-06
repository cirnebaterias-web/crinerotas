import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { NavigationActions } from './navigation-actions';

vi.mock('@/lib/copy-address', () => ({ copyAddress: vi.fn() }));

const client = { name: 'Cliente sintético', address: 'Endereço cadastral', latitude: '0', longitude: '0',
  googleLocation: { address: 'Endereço Google', placeId: 'ChIJ-synthetic', status: 'REVISAR_ENDERECO_PARCIAL', precision: 'RANGE_INTERPOLATED' } };

describe('navigation source metadata', () => {
  it('renders the Google destination and its source quality without promising verification', () => {
    const html = renderToStaticMarkup(<NavigationActions client={client} offline={false} busy={false} />);
    expect(html).toContain('destination_place_id=ChIJ-synthetic');
    expect(html).toContain('destination=Endere%C3%A7o+Google');
    expect(html).not.toContain('destination=0%2C0');
    expect(html).toContain('REVISAR_ENDERECO_PARCIAL');
    expect(html).toContain('RANGE_INTERPOLATED');
    expect(html).toContain('ainda não validada em campo');
  });
  it('retains source information offline, but does not offer external navigation', () => {
    const html = renderToStaticMarkup(<NavigationActions client={client} offline busy={false} />);
    expect(html).not.toContain('href=');
    expect(html).toContain('Endereço Google');
    expect(html).toContain('Copiar endereço');
  });
  it('keeps old snapshots navigable with an explicit missing-source state', () => {
    const html = renderToStaticMarkup(<NavigationActions client={{ ...client, googleLocation: null }} offline={false} busy={false} />);
    expect(html).toContain('destination=0%2C0');
    expect(html).toContain('Referência Google não disponível nesta versão');
  });
});
