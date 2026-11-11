import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StatusBanner } from '../feedback/status-banner';
import { Button, Progress, StatusChip } from './index';

describe('Cirne Momentum primitives', () => {
  it('keeps button variants, legacy hooks and loading semantics together', () => {
    const markup = renderToStaticMarkup(<Button
      className="seller-button seller-primary"
      loading
      loadingLabel="Salvando rota"
    >Salvar rota</Button>);

    expect(markup).toContain('cr-button cr-button--primary seller-button seller-primary');
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('aria-label="Salvando rota"');
  });

  it('renders textual status rather than relying on tone alone', () => {
    const markup = renderToStaticMarkup(<StatusChip tone="success">Sincronizado</StatusChip>);

    expect(markup).toContain('cr-status-chip--success');
    expect(markup).toContain('Sincronizado');
  });

  it('uses the native progress element and clamps invalid values', () => {
    const markup = renderToStaticMarkup(<Progress value={120} max={100} label="Progresso da rota" />);

    expect(markup).toContain('<progress value="100" max="100" aria-label="Progresso da rota"');
    expect(markup).toContain('100%');
  });

  it('announces errors immediately and keeps a visible textual title', () => {
    const markup = renderToStaticMarkup(<StatusBanner tone="error">Tente novamente.</StatusBanner>);

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('Erro');
    expect(markup).toContain('Tente novamente.');
  });
});
