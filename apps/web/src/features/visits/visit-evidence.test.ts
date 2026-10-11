import { describe, expect, it } from 'vitest';
import { distanceMeters, locationAssessment } from './visit-evidence';

describe('visit facade evidence location rules', () => {
  it('accepts an accurate point inside 100 meters', () => {
    const result = locationAssessment({
      latitude: -7.115,
      longitude: -34.864,
      accuracyM: 12,
      clientLatitude: '-7.1152',
      clientLongitude: '-34.8642',
    });
    expect(result.issues).toEqual([]);
    expect(result.distanceM).toBeLessThan(100);
  });

  it('flags low accuracy and points outside the radius without accusing fraud', () => {
    const result = locationAssessment({
      latitude: -7.115,
      longitude: -34.864,
      accuracyM: 80,
      clientLatitude: '-7.12',
      clientLongitude: '-34.87',
    });
    expect(result.issues).toEqual(['gps_low_accuracy', 'outside_radius']);
    expect(result.distanceM).toBeGreaterThan(100);
  });

  it('requires review when the client has no registered coordinates', () => {
    expect(locationAssessment({
      latitude: -7.115,
      longitude: -34.864,
      accuracyM: 10,
      clientLatitude: null,
      clientLongitude: null,
    })).toEqual({ issues: ['client_location_missing'], distanceM: undefined });
  });

  it('uses a stable haversine distance', () => {
    expect(distanceMeters(
      { latitude: 0, longitude: 0 },
      { latitude: 0, longitude: 0.001 },
    )).toBeCloseTo(111.19, 1);
  });
});
