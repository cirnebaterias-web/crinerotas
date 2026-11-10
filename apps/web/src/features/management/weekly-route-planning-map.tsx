'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { WeeklyRoutePlanningCandidate, WeeklyRoutePlanningResponse } from '@cirne/contracts';
import { approximateDistanceKm } from '@cirne/domain';
import type { ManagementMapPublicConfig } from '@cirne/config/server';
import type { Circle, CircleMarker, Map as LeafletMap } from 'leaflet';

type Segment = 'all' | 'first_line' | 'second_line' | 'motorcycle' | 'heavy';
type Coordinate = { latitude: number; longitude: number };
type SelectionCircle = { center: Coordinate; radiusKm: number };
type Props = {
  planning: WeeklyRoutePlanningResponse;
  mapConfig: ManagementMapPublicConfig;
  selectedIds: string[];
  onSelection: (clientIds: string[]) => void;
};
const segmentLabels: Record<Segment, string> = { all: 'Todos os segmentos', first_line: 'Primeira linha',
  second_line: 'Segunda linha', motorcycle: 'Moto', heavy: 'Bateria pesada' };

// Use the same distance reference for the drag preview and the numeric alternative.
export function circleSelectionIds(candidates: Array<Pick<WeeklyRoutePlanningCandidate, 'clientId' | 'location'>>,
  circle: SelectionCircle): string[] {
  return [...new Set(candidates.filter(({ location }) => location !== null
    && approximateDistanceKm(circle.center, location) <= circle.radiusKm + 1e-7).map(({ clientId }) => clientId))];
}

export function WeeklyRoutePlanningMap(props: Props) {
  return <PlanningMapContext key={`${props.planning.sellerId}:${props.planning.weekStart}`} {...props} />;
}

function PlanningMapContext({ planning, mapConfig, selectedIds, onSelection }: Props) {
  const tileUrl = mapConfig.enabled ? mapConfig.tileUrl : null;
  const attribution = mapConfig.enabled ? mapConfig.attribution : null;
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const leafletRef = useRef<typeof import('leaflet') | null>(null);
  const markersRef = useRef(new Map<string, CircleMarker>());
  const originMarkerRef = useRef<CircleMarker | null>(null);
  const circleRef = useRef<Circle | null>(null);
  const drawingRef = useRef(false);
  const dragRef = useRef<{ pointerId: number; center: Coordinate } | null>(null);
  const restoreNavigationRef = useRef<(() => void) | null>(null);
  const [maxDays, setMaxDays] = useState(180);
  const [fallingOnly, setFallingOnly] = useState(false);
  const [delayedOnly, setDelayedOnly] = useState(false);
  const [highPotentialOnly, setHighPotentialOnly] = useState(false);
  const [segment, setSegment] = useState<Segment>('all');
  const [drawing, setDrawing] = useState(false);
  const [draft, setDraft] = useState<SelectionCircle | null>(null);
  const [centerLatitude, setCenterLatitude] = useState(String(planning.origin.latitude));
  const [centerLongitude, setCenterLongitude] = useState(String(planning.origin.longitude));
  const [radiusKm, setRadiusKm] = useState('5');
  const [mapReady, setMapReady] = useState(false);
  const [mapFailure, setMapFailure] = useState(false);
  const [tileFailure, setTileFailure] = useState(false);
  const filtered = useMemo(() => planning.candidates.filter((candidate) =>
    (candidate.daysSinceLastPurchase ?? 181) <= maxDays
    && (!fallingOnly || candidate.purchaseTrend === 'falling')
    && (!delayedOnly || (candidate.cycleDelayDays ?? 0) > 0)
    && (!highPotentialOnly || candidate.potential === 'high')
    && (segment === 'all' || candidate.opportunitySegments.includes(segment))),
  [delayedOnly, fallingOnly, highPotentialOnly, maxDays, planning.candidates, segment]);
  const positioned = useMemo(() => filtered.filter((candidate) => candidate.location !== null), [filtered]);
  const latestRef = useRef({ positioned, selectedIds, onSelection, origin: planning.origin });
  useEffect(() => { latestRef.current = { positioned, selectedIds, onSelection, origin: planning.origin }; });
  const previewIds = useMemo(() => draft ? circleSelectionIds(positioned, draft) : [], [draft, positioned]);
  const selectedVisible = filtered.filter(({ clientId }) => selectedIds.includes(clientId)).length;
  const numericCircle = centerLatitude.trim() && centerLongitude.trim() && radiusKm.trim()
    && Number.isFinite(Number(centerLatitude)) && Math.abs(Number(centerLatitude)) <= 90
    && Number.isFinite(Number(centerLongitude)) && Math.abs(Number(centerLongitude)) <= 180
    && Number.isFinite(Number(radiusKm)) && Number(radiusKm) >= 0
    ? { center: { latitude: Number(centerLatitude), longitude: Number(centerLongitude) }, radiusKm: Number(radiusKm) }
    : null;

  function endDrawing() {
    drawingRef.current = false;
    dragRef.current = null;
    restoreNavigationRef.current?.();
    restoreNavigationRef.current = null;
    setDrawing(false);
  }

  // The keyed parent owns context identity. Refreshes, filters and selection do not
  // belong to this instance's lifecycle and never trigger automatic framing.
  useEffect(() => {
    let active = true;
    let disposePointers: (() => void) | undefined;
    setMapReady(false);
    setMapFailure(false);
    setTileFailure(false);
    async function mount() {
      if (!mapConfig.enabled || !containerRef.current) return;
      try {
        const L = await import('leaflet');
        if (!active || !containerRef.current) return;
        const container = containerRef.current;
        const map = L.map(container, { zoomControl: true });
        mapRef.current = map;
        leafletRef.current = L;
        const tiles = L.tileLayer(mapConfig.tileUrl, { attribution: mapConfig.attribution, maxZoom: 19 });
        tiles.on('tileerror', () => { if (active) setTileFailure(true); });
        tiles.addTo(map);
        const resizePopup = () => container.style.setProperty('--route-popup-max-width', `${Math.max(100, map.getSize().x - 64)}px`);
        map.on('resize', resizePopup);
        resizePopup();

        function updateDrag(event: PointerEvent) {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          const point = map.mouseEventToLatLng(event);
          const circle = { center: drag.center, radiusKm: approximateDistanceKm(drag.center,
            { latitude: point.lat, longitude: point.lng }) };
          setDraft(circle);
          setCenterLatitude(String(circle.center.latitude));
          setCenterLongitude(String(circle.center.longitude));
          setRadiusKm(String(circle.radiusKm));
        }
        function pointerDown(event: PointerEvent) {
          if (!drawingRef.current || event.button !== 0 || dragRef.current
            || (event.target instanceof Element && event.target.closest('.leaflet-control'))) return;
          event.preventDefault();
          event.stopPropagation();
          const point = map.mouseEventToLatLng(event);
          dragRef.current = { pointerId: event.pointerId, center: { latitude: point.lat, longitude: point.lng } };
          container.setPointerCapture(event.pointerId);
          updateDrag(event);
        }
        function pointerMove(event: PointerEvent) {
          if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) return;
          event.preventDefault();
          event.stopPropagation();
          updateDrag(event);
        }
        function pointerUp(event: PointerEvent) {
          if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) return;
          event.preventDefault();
          event.stopPropagation();
          updateDrag(event);
          endDrawing();
          if (container.hasPointerCapture(event.pointerId)) container.releasePointerCapture(event.pointerId);
        }
        function pointerCancel(event: PointerEvent) {
          if (dragRef.current?.pointerId !== event.pointerId) return;
          setDraft(null);
          endDrawing();
        }
        function escape(event: KeyboardEvent) {
          if (event.key !== 'Escape' || !drawingRef.current) return;
          event.preventDefault();
          setDraft(null);
          endDrawing();
        }
        container.addEventListener('pointerdown', pointerDown, true);
        container.addEventListener('pointermove', pointerMove, true);
        container.addEventListener('pointerup', pointerUp, true);
        container.addEventListener('pointercancel', pointerCancel, true);
        container.addEventListener('lostpointercapture', pointerCancel, true);
        container.addEventListener('keydown', escape, true);
        disposePointers = () => {
          container.removeEventListener('pointerdown', pointerDown, true);
          container.removeEventListener('pointermove', pointerMove, true);
          container.removeEventListener('pointerup', pointerUp, true);
          container.removeEventListener('pointercancel', pointerCancel, true);
          container.removeEventListener('lostpointercapture', pointerCancel, true);
          container.removeEventListener('keydown', escape, true);
        };
        const current = latestRef.current;
        const bounds = current.positioned.map(({ location }) =>
          [location!.latitude, location!.longitude] as [number, number]);
        bounds.push([current.origin.latitude, current.origin.longitude]);
        map.fitBounds(bounds, { padding: [24, 24], maxZoom: 13 });
        setMapReady(true);
      } catch {
        if (active) {
          disposePointers?.();
          mapRef.current?.remove();
          mapRef.current = null;
          leafletRef.current = null;
          setMapFailure(true);
        }
      }
    }
    void mount();
    return () => {
      active = false;
      disposePointers?.();
      drawingRef.current = false;
      dragRef.current = null;
      restoreNavigationRef.current?.();
      restoreNavigationRef.current = null;
      markersRef.current.clear();
      originMarkerRef.current = null;
      circleRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
      leafletRef.current = null;
    };
  }, [mapConfig.enabled, tileUrl, attribution]);

  // Reconcile layers without replacing marker DOM, an open popup or the map view.
  useEffect(() => {
    const map = mapRef.current;
    const L = leafletRef.current;
    if (!mapReady || !map || !L) return;
    const visibleIds = new Set(positioned.map(({ clientId }) => clientId));
    for (const [clientId, marker] of markersRef.current) {
      if (!visibleIds.has(clientId)) { marker.remove(); markersRef.current.delete(clientId); }
    }
    for (const candidate of positioned) {
      const chosen = selectedIds.includes(candidate.clientId);
      const color = chosen ? '#ff7900' : candidate.potential === 'high' ? '#b9412c' : '#11834f';
      let marker = markersRef.current.get(candidate.clientId);
      if (!marker) {
        marker = L.circleMarker([candidate.location!.latitude, candidate.location!.longitude]);
        marker.addTo(map);
        markersRef.current.set(candidate.clientId, marker);
      }
      const currentLocation = marker.getLatLng();
      if (currentLocation.lat !== candidate.location!.latitude || currentLocation.lng !== candidate.location!.longitude) {
        marker.setLatLng([candidate.location!.latitude, candidate.location!.longitude]);
      }
      marker.setStyle({ color, fillColor: color, fillOpacity: .78, weight: chosen ? 4 : 2 });
      marker.setRadius(chosen ? 10 : 7);
      const element = marker.getElement() as SVGElement | undefined;
      if (element) {
        element.setAttribute('tabindex', '0');
        element.setAttribute('role', 'button');
        element.setAttribute('aria-label', `Detalhes de ${candidate.name}`);
        element.setAttribute('aria-haspopup', 'dialog');
        element.onkeydown = (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            if (!drawingRef.current) marker?.openPopup();
          }
        };
      }
      const tooltip = document.createElement('span');
      tooltip.textContent = candidate.name;
      if (marker.getTooltip()) marker.setTooltipContent(tooltip);
      else marker.bindTooltip(tooltip, { className: 'route-intelligence-tooltip', direction: 'top' });
      // Keep an open popup intact when only its selection state changes.
      if (!marker.isPopupOpen()) {
        const popup = document.createElement('section');
        popup.setAttribute('role', 'dialog');
        popup.setAttribute('aria-label', `Detalhes de ${candidate.name}`);
        popup.tabIndex = -1;
        const title = document.createElement('strong'); title.textContent = candidate.name;
        const detail = document.createElement('p'); detail.textContent = candidate.reasons.join(' · ');
        const choose = document.createElement('button'); choose.type = 'button';
        const updateChoice = () => {
          const selected = latestRef.current.selectedIds.includes(candidate.clientId);
          choose.textContent = selected ? 'Desmarcar cliente' : 'Selecionar cliente';
          choose.setAttribute('aria-pressed', String(selected));
        };
        choose.onclick = () => {
          const current = latestRef.current;
          const selected = current.selectedIds.includes(candidate.clientId);
          current.onSelection(selected ? current.selectedIds.filter((id) => id !== candidate.clientId)
            : [...new Set([...current.selectedIds, candidate.clientId])]);
        };
        updateChoice();
        const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Fechar detalhes';
        const closePopup = () => { marker?.closePopup(); element?.focus({ preventScroll: true }); };
        close.onclick = closePopup;
        popup.onkeydown = (event) => { if (event.key === 'Escape') { event.stopPropagation(); closePopup(); } };
        popup.append(title, detail, choose, close);
        marker.bindPopup(popup, { className: 'route-intelligence-popup', maxWidth: 280, minWidth: 100,
          autoPan: true, autoPanPadding: [16, 16], closeButton: false });
        marker.off('popupopen');
        marker.on('popupopen', () => { updateChoice(); popup.focus({ preventScroll: true }); });
      } else {
        const popup = marker.getPopup()?.getContent() as HTMLElement | undefined;
        const button = popup?.querySelector('button');
        const title = popup?.querySelector('strong');
        const detail = popup?.querySelector('p');
        if (title && title.textContent !== candidate.name) title.textContent = candidate.name;
        if (detail && detail.textContent !== candidate.reasons.join(' · ')) detail.textContent = candidate.reasons.join(' · ');
        popup?.setAttribute('aria-label', `Detalhes de ${candidate.name}`);
        if (button) { button.textContent = chosen ? 'Desmarcar cliente' : 'Selecionar cliente'; button.setAttribute('aria-pressed', String(chosen)); }
      }
    }
    const origin = planning.origin;
    if (!originMarkerRef.current) {
      originMarkerRef.current = L.circleMarker([origin.latitude, origin.longitude], {
        radius: 9, color: '#092f20', fillColor: '#fff', fillOpacity: 1, weight: 4,
      }).addTo(map);
    }
    const originLabel = document.createElement('span'); originLabel.textContent = `Cidade-base: ${origin.city}/${origin.state}`;
    originMarkerRef.current.setLatLng([origin.latitude, origin.longitude]).unbindTooltip()
      .bindTooltip(originLabel, { className: 'route-intelligence-tooltip' });
  }, [mapReady, planning.origin, positioned, selectedIds]);

  useEffect(() => {
    const map = mapRef.current;
    const L = leafletRef.current;
    if (!mapReady || !map || !L) return;
    if (!draft) { circleRef.current?.remove(); circleRef.current = null; return; }
    if (!circleRef.current) circleRef.current = L.circle([draft.center.latitude, draft.center.longitude], {
      radius: draft.radiusKm * 1000, color: '#ff7900', fillOpacity: .12, interactive: false,
    }).addTo(map);
    else circleRef.current.setLatLng([draft.center.latitude, draft.center.longitude]).setRadius(draft.radiusKm * 1000);
  }, [draft, mapReady]);

  function startDrawing() {
    const map = mapRef.current;
    if (!map) return;
    endDrawing();
    setDraft(null);
    map.closePopup();
    const handlers = [map.dragging, map.doubleClickZoom, map.touchZoom, map.scrollWheelZoom, map.boxZoom, map.keyboard];
    const enabled = handlers.filter((handler) => handler.enabled());
    enabled.forEach((handler) => handler.disable());
    restoreNavigationRef.current = () => enabled.forEach((handler) => handler.enable());
    drawingRef.current = true;
    setDrawing(true);
    containerRef.current?.focus({ preventScroll: true });
  }

  function cancelPreview() { endDrawing(); setDraft(null); }
  function frameClients() {
    const bounds = positioned.map(({ location }) => [location!.latitude, location!.longitude] as [number, number]);
    bounds.push([planning.origin.latitude, planning.origin.longitude]);
    mapRef.current?.fitBounds(bounds, { padding: [24, 24], maxZoom: 13 });
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
    <div className="route-intelligence-summary" aria-live="polite"><strong>{filtered.length} clientes visíveis</strong>
      <span>{positioned.length} no mapa · {selectedIds.length} selecionados ({selectedVisible} visíveis,
        {' '}{selectedIds.length - selectedVisible} fora dos filtros) · {filtered.length - positioned.length} com localização pendente
        {' '}· limite de 30 km entre paradas</span></div>
    {mapConfig.enabled && !mapFailure
      ? <div ref={containerRef} className={`route-intelligence-canvas${drawing ? ' is-drawing' : ''}`}
        tabIndex={0} aria-label="Clientes elegíveis no mapa" />
      : <p className="route-planner-empty">Mapa indisponível; os filtros e a lista de prioridades continuam utilizáveis.</p>}
    {tileFailure && <p role="status" className="route-planner-empty">O fundo do mapa está indisponível. Marcadores, seleção e lista continuam utilizáveis.</p>}
    <div className="route-intelligence-selection">
      <button type="button" onClick={frameClients} disabled={!mapReady || mapFailure}>Enquadrar clientes</button>
      <button type="button" onClick={startDrawing} disabled={!mapReady || mapFailure} aria-pressed={drawing}>
        {draft || drawing ? 'Refazer círculo no mapa' : 'Desenhar círculo no mapa'}</button>
      <button type="button" onClick={() => { cancelPreview(); onSelection([]); }}
        disabled={selectedIds.length === 0 && !draft && !drawing}>Limpar seleção</button>
    </div>
    {drawing && <p role="status">Modo de seleção: arraste do centro até a borda do círculo, com mouse ou toque.
      Ao soltar, revise a prévia. Escape ou Cancelar restaura a navegação.</p>}
    <fieldset className="route-intelligence-circle-inputs"><legend>Selecionar por centro e raio, sem arrastar</legend>
      <label>Latitude do centro<input type="number" min="-90" max="90" step="any" value={centerLatitude}
        onChange={(event) => { setCenterLatitude(event.target.value); setDraft(null); }} /></label>
      <label>Longitude do centro<input type="number" min="-180" max="180" step="any" value={centerLongitude}
        onChange={(event) => { setCenterLongitude(event.target.value); setDraft(null); }} /></label>
      <label>Raio (km)<input type="number" min="0" step="any" value={radiusKm}
        onChange={(event) => { setRadiusKm(event.target.value); setDraft(null); }} /></label>
      <button type="button" disabled={!numericCircle} onClick={() => { endDrawing(); if (numericCircle) setDraft(numericCircle); }}>
        Pré-visualizar círculo</button>
    </fieldset>
    {(draft || drawing) && <div className="route-intelligence-selection">
      {draft && <span role="status">Prévia: {previewIds.length} clientes filtrados na área (raio {draft.radiusKm.toLocaleString('pt-BR', { maximumFractionDigits: 2 })} km).
        Aplicar substitui a seleção pelos clientes visíveis nesta área.</span>}
      <button type="button" disabled={!draft || drawing} onClick={() => { onSelection(previewIds); cancelPreview(); }}>Aplicar seleção</button>
      <button type="button" onClick={cancelPreview}>Cancelar seleção de área</button>
    </div>}
    <p className="route-planner-help">Todos os {filtered.length} resultados estão na lista abaixo. Use Tab para selecionar por teclado,
      inclusive clientes sem coordenadas. A seleção é local; adicionar ao dia exige validação do servidor.</p>
    <ol className="route-intelligence-priorities" aria-label="Todos os clientes filtrados">{filtered.map((candidate) => <li key={candidate.clientId}>
      <input type="checkbox" checked={selectedIds.includes(candidate.clientId)} onChange={() =>
        onSelection(selectedIds.includes(candidate.clientId) ? selectedIds.filter((id) => id !== candidate.clientId)
          : [...new Set([...selectedIds, candidate.clientId])])} aria-label={`Selecionar ${candidate.name}`} />
      <div><strong>{candidate.name}</strong><span>{candidate.reasons.join(' · ')}</span>
        {!candidate.location && <span>Sem coordenadas · localização pendente</span>}</div>
      <b>{candidate.score.toLocaleString('pt-BR')}</b>
    </li>)}</ol>
  </section>;
}
