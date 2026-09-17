import { describe, expect, it } from 'vitest';
import { actorKeys, createManifest, parseManifest, syntheticClientIds } from './provision-synthetic-actors';

describe('synthetic actor manifest', () => {
  it('uses fixed UUIDs only for the two local synthetic clients', () => {
    expect(syntheticClientIds).toEqual([
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000003',
    ]);
  });
  it('creates all isolated actors without real domains or fixed credentials', () => {
    const first = createManifest();
    const second = createManifest();
    expect(Object.keys(first.actors)).toEqual(actorKeys);
    for (const key of actorKeys) {
      expect(first.actors[key].email).toMatch(/@example\.invalid$/);
      expect(first.actors[key].password.length).toBeGreaterThanOrEqual(24);
      expect(first.actors[key].password).not.toBe(second.actors[key].password);
    }
  });

  it('round-trips a valid manifest and rejects incomplete or real-address data', () => {
    const manifest = createManifest();
    expect(parseManifest(JSON.stringify(manifest))).toEqual(manifest);
    expect(() => parseManifest('{}')).toThrow(/incompat.vel/);
    manifest.actors.seller_a.email = 'person@example.com';
    expect(() => parseManifest(JSON.stringify(manifest))).toThrow(/incompat.vel/);
  });
});
