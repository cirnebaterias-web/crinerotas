'use client';

import { Component, useEffect, useRef, type ReactNode } from 'react';
import type { StockInput, StockInsights, StockInsightsExclusionReason } from '@cirne/contracts';
import { analyzeStockInsights, supportedStockInsightsCatalogs } from '@cirne/domain';

type Props = { snapshot: StockInput; onEdit: () => void; onContinue: () => void };

const reasonLabels: Record<StockInsightsExclusionReason, string> = {
  manual_line: 'Modelo manual sem código de catálogo',
  missing_catalog_version: 'Versão de catálogo ausente',
  unsupported_catalog_version: 'Versão de catálogo não suportada',
  product_not_found: 'Código não encontrado na versão informada',
  brand_mismatch: 'Marca diferente da registrada no catálogo',
  missing_amperage: 'Amperagem canônica indisponível',
  unknown_technology: 'Tecnologia não classificada',
  outside_commercial_pairs: 'Marca fora dos três pares comerciais',
};
const formatUnits = (value: number | null) => value === null ? 'Indisponível' : `${value.toLocaleString('pt-BR')} un.`;
const formatShare = (value: number | null) => value === null ? 'Indisponível' : `${value.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;

export function StockInsightsUnavailable() {
  return <p className="seller-notice" role="status">Análise indisponível neste momento. O estoque salvo está preservado. Você pode editar os dados ou continuar para fotos.</p>;
}

/** Isolates render failures from navigation and the already committed visit. */
export class StockInsightsBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <StockInsightsUnavailable /> : this.props.children; }
}

function StockInsightsReading({ analysis }: { analysis: StockInsights }) {
  const { overall, coverage } = analysis;
  return <>
    <section className="seller-insights-section" aria-labelledby="stock-share-title">
      <h3 id="stock-share-title">Participação no estoque observado</h3>
      {overall.state === 'empty' ? <p className="seller-insights-highlight">Sem estoque observado</p> :
        overall.state === 'insufficient' ? <p className="seller-notice">Leitura detalhada insuficiente: faltam linhas próprias ou concorrentes no registro legado.</p> :
          <p className="seller-insights-highlight">{formatShare(overall.ownSharePercent)} <span>das nossas marcas</span></p>}
      <dl className="seller-insights-metrics">
        <div><dt>Próprias</dt><dd>{formatUnits(overall.ownUnits)}</dd></div>
        <div><dt>Concorrentes</dt><dd>{formatUnits(overall.rivalUnits)}</dd></div>
        <div><dt>Total observado</dt><dd>{formatUnits(overall.totalUnits)}</dd></div>
      </dl>
      {overall.state === 'available' && <p>Concorrência: {formatShare(overall.rivalSharePercent)}. Próprias: Heliar, América, Durex/Strada e ACDelco.</p>}
    </section>

    <section className="seller-insights-section" aria-labelledby="stock-pairs-title">
      <h3 id="stock-pairs-title">Comparações por marca</h3>
      <p className="seller-muted">Cada participação considera somente as marcas daquele par.</p>
      {analysis.pairs.map((pair) => <article className="seller-insights-pair" key={pair.id}>
        <h4>{pair.label}</h4>
        {pair.state === 'insufficient' ? <p>Comparação indisponível: registro incompleto.</p> : <>
            {pair.state === 'empty' && <p>Sem estoque observado</p>}
            <p>Própria: <strong>{formatUnits(pair.ownUnits)} · {formatShare(pair.ownSharePercent)}</strong></p>
            <p>Rival: <strong>{formatUnits(pair.rivalUnits)} · {formatShare(pair.rivalSharePercent)}</strong></p>
            <p>Diferença (própria − rival): {pair.differenceUnits.toLocaleString('pt-BR')} un.</p>
          </>}
        {pair.cuts.length > 0 && <details><summary>Ver recortes por Ah e tecnologia ({pair.cuts.length})</summary>
          <ul>{pair.cuts.map((cut) => <li key={`${cut.amperageAh}:${cut.family}`}>
            <strong>{cut.amperageAh} Ah · {cut.family}</strong><br />
            Própria {formatUnits(cut.ownUnits)} · rival {formatUnits(cut.rivalUnits)}
          </li>)}</ul>
        </details>}
      </article>)}
    </section>

    <section className="seller-insights-section" aria-labelledby="stock-opportunities-title">
      <h3 id="stock-opportunities-title">Oportunidades observadas</h3>
      {coverage.partial && <p className="seller-notice">Cobertura parcial: há linhas fora dos recortes. Uma ausência neste recorte não comprova ruptura no PDV.</p>}
      {analysis.readingState === 'insufficient' ? <p>Dados insuficientes para identificar oportunidades.</p> :
        analysis.readingState === 'no_classifiable_data' ? <p>Não há dados classificáveis.</p> :
          analysis.readingState === 'no_opportunities' ? <p>Nenhuma oportunidade identificada no recorte analisável.</p> :
            <ol className="seller-insights-opportunities">{analysis.opportunities.map((opportunity) =>
              <li key={`${opportunity.pairId}:${opportunity.amperageAh}:${opportunity.family}`}>
                <h4>{opportunity.kind === 'absence' ? 'Ausência no recorte observado' : 'Gap observado'}</h4>
                <p><strong>{opportunity.ownBrand === 'Durex' ? 'Durex/Strada' : opportunity.ownBrand} · {opportunity.amperageAh} Ah · {opportunity.family}</strong></p>
                <p>Própria {formatUnits(opportunity.ownUnits)} · rival {formatUnits(opportunity.rivalUnits)}. Diferença observada: {formatUnits(opportunity.gapUnits)}.</p>
                {opportunity.models.length === 0 ? <p>Sem modelo correspondente no catálogo offline</p> :
                  <details><summary>Ver modelos no catálogo ({opportunity.models.length})</summary>
                    <ul>{opportunity.models.map((model) => <li key={model.code}>{model.model} · código {model.code}</li>)}</ul>
                  </details>}
              </li>)}</ol>}
    </section>

    <section className="seller-insights-section" aria-labelledby="stock-coverage-title">
      <h3 id="stock-coverage-title">Cobertura e limitações</h3>
      <p>Totais gerais: {coverage.general.observed.lines} linha(s) disponível(is), {formatUnits(coverage.general.observed.units)}. {coverage.general.ownLinesAvailable && coverage.general.rivalLinesAvailable ? 'Todas as linhas salvas entram no share geral.' : 'Arrays de linhas ausentes não equivalem a estoque zerado.'}</p>
      <p>Recortes: {coverage.analytical.included.lines} linha(s), {formatUnits(coverage.analytical.included.units)} incluídas; {coverage.analytical.excluded.lines} linha(s), {formatUnits(coverage.analytical.excluded.units)} excluídas.</p>
      <p>Uma linha pode entrar no share geral e ficar fora dos cortes por Ah e tecnologia.</p>
      {coverage.analytical.reasons.length > 0 && <ul>{coverage.analytical.reasons.map((reason) =>
        <li key={reason.reason}>{reasonLabels[reason.reason]}: {reason.lines} linha(s), {formatUnits(reason.units)}.</li>)}</ul>}
      {(!coverage.general.ownLinesAvailable || !coverage.general.rivalLinesAvailable) && <p>Agregados legados, separados dos totais: Heliar {formatUnits(coverage.legacy.heliarQuantity)}; Moura {formatUnits(coverage.legacy.mouraQuantity)}.</p>}
      <p className="seller-notice">{analysis.caution}</p>
    </section>
  </>;
}

function CalculateStockInsights({ snapshot }: { snapshot: StockInput }) {
  let analysis: StockInsights;
  // The local record also carries commit/sync metadata, outside the pure input contract.
  const { heliarQuantity, mouraQuantity, ownLines, competitorLines, completedOwnBrands, observation } = snapshot;
  try { analysis = analyzeStockInsights({ snapshot: {
    heliarQuantity, mouraQuantity, ownLines, competitorLines, completedOwnBrands, observation,
  }, ...supportedStockInsightsCatalogs }); }
  catch { return <StockInsightsUnavailable />; }
  return <StockInsightsReading analysis={analysis} />;
}

export function VisitStockInsightsStep({ snapshot, onEdit, onContinue }: Props) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { titleRef.current?.focus(); }, []);
  return <section className="seller-stock-card seller-stock-insights" aria-labelledby="stock-insights-title">
    <p className="seller-kicker">ESTOQUE · REVISÃO DA COLETA</p>
    <h2 id="stock-insights-title" ref={titleRef} tabIndex={-1}>Análise do estoque</h2>
    <p className="seller-muted">Após concorrência, antes das fotos. Leitura do estoque salvo neste aparelho.</p>
    <StockInsightsBoundary><CalculateStockInsights snapshot={snapshot} /></StockInsightsBoundary>
    <div className="seller-insights-actions">
      <button className="seller-button seller-secondary" type="button" onClick={onEdit}>Editar estoque</button>
      <button className="seller-button seller-primary" type="button" onClick={onContinue}>Continuar para fotos</button>
    </div>
  </section>;
}
