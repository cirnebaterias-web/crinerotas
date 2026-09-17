import { describe, expect, it } from 'vitest';
import type { CanonicalRoute } from '@cirne/contracts';
import { movePending, pendingIds, routeProgress, formatServiceDate } from './route-model';

const stops: CanonicalRoute['stops'] = ['pending', 'completed', 'pending', 'in_visit', 'not_visited', 'pending'].map((status, index) => ({
  routeVersionStopId: String(index), plannedOrder: index + 1, executionOrder: index + 1,
  priority: 0, executionVersion: 1, status: status as CanonicalRoute['stops'][number]['status'],
  client: { id: String(index), name: 'Cliente', address: 'Endereço', latitude: null, longitude: null, externalReference: null, portfolioReference: null },
}));

describe('seller route presentation', () => {
  it('moves only pending stops, preserving fixed slots and canonical input', () => {
    const moved = movePending(stops, '0', 1);
    expect(pendingIds(moved)).toEqual(['2', '0', '5']);
    expect(moved.map((s) => s.executionOrder)).toEqual([1, 2, 3, 4, 5, 6]);
    for (const index of [1, 3, 4]) expect(moved[index]).toEqual(stops[index]);
    expect(pendingIds(stops)).toEqual(['0', '2', '5']);
    expect(moved[0]?.plannedOrder).toBe(3);
  });
  it('handles boundaries, unknown and nonpending stops without mutation', () => {
    for (const [id, direction] of [['0', -1], ['5', 1], ['1', 1], ['unknown', 1]] as const) {
      expect(movePending(stops, id, direction)).toEqual(stops);
    }
  });
  it('counts only completed visits and formats the canonical day', () => {
    expect(routeProgress(stops)).toEqual({ completed: 1, total: 6, percent: 17 });
    expect(routeProgress([])).toEqual({ completed: 0, total: 0, percent: 0 });
    expect(formatServiceDate('2026-09-16')).toContain('16 de setembro');
  });
});
