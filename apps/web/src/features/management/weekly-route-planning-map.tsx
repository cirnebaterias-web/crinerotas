'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { WeeklyRoutePlanningResponse } from '@cirne/contracts';
import { pointInPolygon } from '@cirne/domain';
import type { ManagementMapPublicConfig } from '@cirne/config/server';
import type { Map as LeafletMap, Polygon } from 'leaflet';

type Segment = 'all' | 'first_line' | 'second_line' | 'motorcycle' | 'heavy';
const segmentLabels: Record<Segment, string> = { all: 'Todos os segmentos', first_line: 'Primeira linha',
  second_line: 'Segunda linha', motorcycle: 'Moto', heavy: 'Bateria pesada' };

export function WeeklyRoutePlanningMap({ planning, mapConfig, selectedIds, onSelection }: {
  planning: WeeklyRoutePlanningResponse;
  mapConfig: ManagementMapPublicConfig;
  selectedIds: string[];
  onSelection: (clientIds: string[]) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const polygonRef = useRef<Polygon | null>(null);
  const drawingRef = useRef(false);
  const pointsRef = useRef<Array<{ latitude: number; longitude: number }>>([]);
  const [maxDays, setMaxDays] = useState(180);
  const [fallingOnly, setFallingOnly] = useState(false);
  const [delayedOnly, setDelayedOnly] = useState(false);
  const [highPotentialOnly, setHighPotentialOnly] = useState(false);
  const [segment, setSegment] = useState<Segment>('all');
  const [drawing, setDrawing] = useState(false);
  const [mapFailure, setMapFailure] = useState(false);
  const filtered = useMemo(() => planning.candidates.filter((candidate) =>
    (candidate.daysSinceLastPurchase ?? 181) <= maxDays
    && (!fallingOnly || candidate.purchaseTrend === 'falling')
    && (!delayedOnly || (candidate.cycleDelayDays ?? 0) > 0)
    && (!highPotentialOnly || candidate.potential === 'high')
    && (segment === 'all' || candidate.opportunitySegments.includes(segment))),
  [delayedOnly, fallingOnly, highPotentialOnly, maxDays, planning.candidates, segment]);
  const positioned = useMemo(() => filtered.filter((candidate) => candidate.location !== null), [filtered]);

  useEffect(() => {
    let active = true;
    async function mount() {
      if (!mapConfig.enabled || !containerRef.current) return;
      try {
        const L = await import('leaflet');
        if (!active || !containerRef.current) return;
        const map = L.map(containerRef.current, { zoomControl: true });
        mapRef.current = map;
        L.tileLayer(mapConfig.tileUrl, { attribution: mapConfig.attribution, maxZoom: 19 }).addTo(map);
        L.circleMarker([planning.origin.latitude, planning.origin.longitude], {
          radius: 9, color: '#092f20', fillColor: '#fff', fillOpacity: 1, weight: 4,
        }).bindTooltip(`Cidade-base: ${planning.origin.city}/${planning.origin.state}`).addTo(map);
        for (const candidate of positioned) {
          const chosen = selectedIds.includes(candidate.clientId);
          const color = chosen ? '#ff7900' : candidate.potential === 'high' ? '#b9412c' : '#11834f';
          const tooltip = document.createElement('div');
          const title = document.createElement('strong'); title.textContent = candidate.name;
          const detail = document.createElement('p'); detail.textContent = candidate.reasons.join(' · ');
          tooltip.append(title, detail);
          const marker = L.circleMarker([candidate.location!.latitude, candidate.location!.longitude], {
            radius: chosen ? 10 : 7, color, fillColor: color, fillOpacity: .78, weight: chosen ? 4 : 2,
          }).bindTooltip(tooltip);
          marker.on('click', () => {
            if (drawingRef.current) return;
            onSelection(chosen ? selectedIds.filter((id) => id !== candidate.clientId)
              : [...selectedIds, candidate.clientId]);
          });
          marker.addTo(map);
        }
        map.on('click', (event) => {
          if (!drawingRef.current) return;
          pointsRef.current = [...pointsRef.current,
            { latitude: event.latlng.lat, longitude: event.latlng.lng }];
          polygonRef.current?.remove();
          polygonRef.current = L.polygon(pointsRef.current.map((point) =>
            [point.latitude, point.longitude] as [number, number]), { color: '#ff7900', fillOpacity: .12 }).addTo(map);
        });
        const bounds = positioned.map(({ location }) =>
          [location!.latitude, location!.longitude] as [number, number]);
        bounds.push([planning.origin.latitude, planning.origin.longitude]);
        map.fitBounds(bounds, { padding: [24, 24], maxZoom: 13 });
      } catch { if (active) setMapFailure(true); }
    }
    void mount();
    return () => { active = false; polygonRef.current = null; mapRef.current?.remove(); mapRef.current = null; };
  }, [mapConfig, onSelection, planning.origin, positioned, selectedIds]);

  function startDrawing() {
    pointsRef.current = [];
    polygonRef.current?.remove();
    polygonRef.current = null;
    drawingRef.current = true;
    setDrawing(true);
  }

  function finishDrawing() {
    if (pointsRef.current.length >= 3) onSelection(positioned.filter(({ location }) =>
      pointInPolygon(location!, pointsRef.current)).map(({ clientId }) => clientId));
    drawingRef.current = false;
    setDrawing(false);
  }

  return <section className="route-intelligence-map" aria-label="Mapa inteligente da carteira">
    <div className="route-intelligence-toolbar">
      <label>Dias sem comprar (até)<input type="number" min="1" max="180" value={maxDays}
        onChange={(event) => setMaxDays(Math.min(180, Math.max(1, Number(event.target.value))))} /></label>
      <label>Oportunidade por produto<select value={segment} onChange={(event) => setSegment(event.target.value as Segment)}>
        {Object.entries(segmentLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label className="route-intelligence-check"><input type="checkbox" checked={delayedOnly}
        onChange={(event) => setDelayedOnly(event.target.checked)} />Fora da periodicidade</label>
      <label className="route-intelligence-check"><input type="checkbox" checked={fallingOnly}
        onChange={(event) => setFallingOnly(event.target.checked)} />Compra em queda</label>
      <label className="route-intelligence-check"><input type="checkbox" checked={highPotentialOnly}
        onChange={(event) => setHighPotentialOnly(event.target.checked)} />Maior potencial</label>
    </div>
    <div className="route-intelligence-summary"><strong>{filtered.length} clientes visíveis</strong>
      <span>{positioned.length} no mapa · {selectedIds.length} selecionados · limite de 30 km entre paradas</span></div>
    {mapConfig.enabled && !mapFailure
      ? <div ref={containerRef} className="route-intelligence-canvas" aria-label="Clientes elegíveis no mapa" />
      : <p className="route-planner-empty">Mapa indisponível; os filtros e a lista de prioridades continuam utilizáveis.</p>}
    <div className="route-intelligence-selection">
      {!drawing ? <button type="button" onClick={startDrawing}>Desenhar seleção no mapa</button>
        : <><span>Clique em pelo menos 3 pontos para formar o polígono.</span>
          <button type="button" onClick={finishDrawing}>Concluir seleção</button></>}
      <button type="button" onClick={() => onSelection([])} disabled={selectedIds.length === 0}>Limpar seleção</button>
    </div>
    <ol className="route-intelligence-priorities">{filtered.slice(0, 20).map((candidate) => <li key={candidate.clientId}>
      <input type="checkbox" checked={selectedIds.includes(candidate.clientId)} onChange={() =>
        onSelection(selectedIds.includes(candidate.clientId) ? selectedIds.filter((id) => id !== candidate.clientId)
          : [...selectedIds, candidate.clientId])} aria-label={`Selecionar ${candidate.name}`} />
      <div><strong>{candidate.name}</strong><span>{candidate.reasons.join(' · ')}</span></div>
      <b>{candidate.score.toLocaleString('pt-BR')}</b>
    </li>)}</ol>
  </section>;
}
