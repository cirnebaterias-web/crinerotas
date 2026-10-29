'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ManagementMapResponse } from '@cirne/contracts';
import type { Map as LeafletMap, Marker } from 'leaflet';

const routeColors = ['#0f5132', '#d85b18', '#1b5fa7', '#7a3e9d', '#8a5b00', '#137f7a'];
const statusLabels = {
  pending: 'Pendente', in_visit: 'Em visita', completed: 'Concluída', not_visited: 'Não visitada',
} as const;

export default function ManagementRouteMap({ result, tileUrl, attribution }: {
  result: ManagementMapResponse;
  tileUrl: string;
  attribution: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const markersRef = useRef(new Map<string, Marker>());
  const [selectedStopId, setSelectedStopId] = useState<string | null>(null);
  const [tileFailure, setTileFailure] = useState(false);
  const [loadFailure, setLoadFailure] = useState(false);
  const positioned = useMemo(() => result.routes.flatMap((route, routeIndex) => route.stops.map((stop) => ({
    route, routeIndex, stop,
  }))).filter((item) => item.stop.location !== null), [result.routes]);

  useEffect(() => {
    let active = true;
    async function mount() {
      if (!containerRef.current || positioned.length === 0) return;
      try {
        const L = await import('leaflet');
        if (!active || !containerRef.current) return;
        const map = L.map(containerRef.current, { zoomControl: true, attributionControl: true });
        mapRef.current = map;
        const tiles = L.tileLayer(tileUrl, { attribution, maxZoom: 19 });
        tiles.on('tileerror', () => { if (active) setTileFailure(true); });
        tiles.addTo(map);
        const bounds: Array<[number, number]> = [];
        for (const { route, routeIndex, stop } of positioned) {
          const location = stop.location!;
          const point: [number, number] = [Number(location.latitude), Number(location.longitude)];
          bounds.push(point);
          const color = routeColors[routeIndex % routeColors.length]!;
          const icon = L.divIcon({
            className: 'management-map-marker-shell',
            html: `<span class="management-map-marker" style="--marker-color:${color}">${stop.executionOrder}</span>`,
            iconSize: [34, 34], iconAnchor: [17, 17], popupAnchor: [0, -18],
          });
          const marker = L.marker(point, { icon, keyboard: true, title: `${stop.executionOrder}. ${stop.client.name}` });
          const popup = document.createElement('section');
          const heading = document.createElement('strong'); heading.textContent = `${stop.executionOrder}. ${stop.client.name}`;
          const detail = document.createElement('p');
          detail.textContent = `${route.seller.displayName} · ${statusLabels[stop.status]} · ordem planejada ${stop.plannedOrder}`;
          const address = document.createElement('p'); address.textContent = stop.client.address;
          popup.append(heading, detail, address);
          marker.bindPopup(popup);
          marker.on('click', () => setSelectedStopId(stop.routeVersionStopId));
          marker.addTo(map);
          markersRef.current.set(stop.routeVersionStopId, marker);
        }
        for (const [routeIndex, route] of result.routes.entries()) {
          const points = route.stops.flatMap((stop) => stop.location
            ? [[Number(stop.location.latitude), Number(stop.location.longitude)] as [number, number]] : []);
          if (points.length > 1) L.polyline(points, {
            color: routeColors[routeIndex % routeColors.length], weight: 3, opacity: 0.7, dashArray: '8 7',
          }).addTo(map);
        }
        map.fitBounds(bounds, { padding: [30, 30], maxZoom: 16 });
        window.requestAnimationFrame(() => map.invalidateSize());
      } catch {
        if (active) setLoadFailure(true);
      }
    }
    void mount();
    return () => {
      active = false;
      markersRef.current.clear();
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [attribution, positioned, result.routes, tileUrl]);

  function selectStop(stopId: string) {
    setSelectedStopId(stopId);
    const marker = markersRef.current.get(stopId);
    if (marker) {
      marker.openPopup();
      mapRef.current?.panTo(marker.getLatLng());
    }
  }

  if (positioned.length === 0) return <section className="management-map-empty" aria-live="polite">
    <h3>Nenhuma parada com coordenadas</h3>
    <p>As {result.totals.unpositioned} parada(s) continuam disponíveis na lista operacional.</p>
  </section>;

  return <div className="management-map-layout">
    <div className="management-map-canvas-wrap">
      {loadFailure
        ? <div className="seller-notice seller-error" role="alert">Não foi possível carregar o componente do mapa. A Central do dia permanece disponível.</div>
        : <div ref={containerRef} className="management-map-canvas" aria-label="Mapa das paradas publicadas" />}
      {tileFailure && <p className="seller-notice" role="status">O provedor de mapa está indisponível. Marcadores e lista permanecem disponíveis.</p>}
      <p className="management-map-attribution">Atribuição: {attribution}</p>
      <p className="management-map-disclaimer">As linhas ligam a sequência das paradas e não representam trajeto por ruas.</p>
    </div>
    <aside className="management-map-list" aria-label="Paradas representadas no mapa">
      <h3>Rotas no mapa</h3>
      {result.routes.map((route, routeIndex) => <section key={route.routeId}>
        <h4><span style={{ backgroundColor: routeColors[routeIndex % routeColors.length] }} />{route.seller.displayName}</h4>
        <ol>{route.stops.map((stop) => <li key={stop.routeVersionStopId}>
          {stop.location ? <button type="button" aria-pressed={selectedStopId === stop.routeVersionStopId}
            onClick={() => selectStop(stop.routeVersionStopId)}>
            <strong>{stop.executionOrder}. {stop.client.name}</strong><small>{statusLabels[stop.status]}</small>
          </button> : <div><strong>{stop.executionOrder}. {stop.client.name}</strong><small>Sem coordenadas</small></div>}
        </li>)}</ol>
      </section>)}
    </aside>
  </div>;
}
