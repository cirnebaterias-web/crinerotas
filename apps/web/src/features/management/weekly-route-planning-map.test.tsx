import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { weeklyRoutePlanningResponseSchema } from '@cirne/contracts';
import { approximateDistanceKm } from '@cirne/domain';
import { circleSelectionIds, WeeklyRoutePlanningMap } from './weekly-route-planning-map';

const sellerId = '11111111-1111-4111-8111-111111111111';
const planning = () => weeklyRoutePlanningResponseSchema.parse({
  schemaVersion: 1, sellerId, weekStart: '2026-11-16', generatedAt: '2026-11-09T14:00:00-03:00',
  origin: { kind: 'base_city', sellerId, city: 'Parnamirim', state: 'RN', ibgeCode: '2403251',
    latitude: -5.91, longitude: -35.26, reference: 'municipal_seat', source: 'IBGE', configVersion: 1 },
  maxLegDistanceKm: 30,
  candidates: Array.from({ length: 65 }, (_, index) => ({
    clientId: `40000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    name: index === 64 ? '<script>Cliente final</script>' : `Cliente ${index + 1}`,
    status: 'active', daysSinceLastPurchase: 75, periodicityDays: 30, averageMonthlyVolume: 80,
    recentVolume3: 120, previousVolume3: 240, opportunitySegments: ['second_line'],
    scrapDebtKg: 300, scrapBalanceState: 'debtor',
    location: index === 64 ? null : { latitude: -5.9, longitude: -35.25 },
    hasNavigableAddress: true, score: 82, distanceFromBaseKm: 12, cycleDelayDays: 45,
    cycleDelayPercent: 150, purchaseTrend: 'falling', potential: 'high',
    coverageState: 'unavailable', coverageOverdueDays: null, nextVisitDueOn: null,
    reasons: ['Texto extenso <img src=x onerror=alert(1)> preservado como texto seguro'],
  })), counts: { total: 65, eligible: 65, positioned: 64, inactiveLost: 0 },
});

describe('weekly route planning map', () => {
  it('exposes every result, including the 21st and unpositioned last result, with the map unavailable', () => {
    const onSelection = vi.fn();
    const html = renderToStaticMarkup(<WeeklyRoutePlanningMap planning={planning()}
      mapConfig={{ enabled: false, reason: 'unconfigured' }} selectedIds={[]} onSelection={onSelection} />);
    expect(html).toContain('65 clientes visíveis');
    expect(html).toContain('Selecionar Cliente 21');
    expect(html).toContain('Selecionar &lt;script&gt;Cliente final&lt;/script&gt;');
    expect(html.match(/aria-label="Selecionar /g)).toHaveLength(65);
    expect(html).toContain('Sem coordenadas · localização pendente');
    expect(html).toContain('Mapa indisponível');
    expect(html).toContain('Latitude do centro');
    expect(html).toContain('Longitude do centro');
    expect(html).toContain('Raio (km)');
    expect(html).toContain('Pré-visualizar círculo');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(onSelection).not.toHaveBeenCalled();
  });

  it('keeps selection totals clear for visible and hidden clients', () => {
    const result = planning();
    const html = renderToStaticMarkup(<WeeklyRoutePlanningMap planning={result}
      mapConfig={{ enabled: false, reason: 'invalid' }} selectedIds={[result.candidates[0]!.clientId, 'hidden']}
      onSelection={vi.fn()} />);
    expect(html).toContain('2 selecionados (1 visíveis, 1 fora dos filtros)');
    expect(html).toContain('1 com localização pendente');
  });
});

describe('circle preview and numeric selection', () => {
  const center = { latitude: -5.91, longitude: -35.26 };
  const edge = { latitude: -5.9, longitude: -35.25 };
  const radiusKm = approximateDistanceKm(center, edge);

  it('includes the exact boundary, excludes outside and missing coordinates, and removes duplicates', () => {
    expect(circleSelectionIds([
      { clientId: 'center', location: center }, { clientId: 'edge', location: edge },
      { clientId: 'edge', location: edge }, { clientId: 'outside', location: { latitude: -5.8, longitude: -35.25 } },
      { clientId: 'unknown', location: null },
    ], { center, radiusKm })).toEqual(['center', 'edge']);
  });

  it('uses the filtered input exclusively and does not add hidden clients', () => {
    expect(circleSelectionIds([{ clientId: 'visible', location: edge }], { center, radiusKm })).toEqual(['visible']);
    expect(circleSelectionIds([], { center, radiusKm })).toEqual([]);
  });

  it('allows a zero radius to select only a client at the center', () => {
    expect(circleSelectionIds([{ clientId: 'center', location: center }, { clientId: 'edge', location: edge }],
      { center, radiusKm: 0 })).toEqual(['center']);
  });
});
