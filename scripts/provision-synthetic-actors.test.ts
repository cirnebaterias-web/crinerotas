import { describe, expect, it } from 'vitest';
import { actorKeys, createManifest, parseManifest, syntheticClientIds } from './provision-synthetic-actors';

describe('synthetic actor manifest', () => {
  it('uses fixed UUIDs only for the three local synthetic clients', () => {
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

  it.each([false, true])('upgrades legacy manifests (manual actors present: %s) without changing credentials', (manualActorsPresent) => {
    const original = createManifest();
    const legacy = { ...original, actors: Object.fromEntries(Object.entries(original.actors)
      .filter(([key]) => !key.endsWith('_regression') && (manualActorsPresent || !key.endsWith('_e2e')))) };
    const upgraded = parseManifest(JSON.stringify(legacy));
    for (const [key, actor] of Object.entries(legacy.actors)) {
      expect(upgraded.actors[key as keyof typeof upgraded.actors]).toEqual(actor);
    }
    expect(upgraded.actors.seller_e2e.email).toMatch(/@example\.invalid$/);
    expect(upgraded.actors.manager_e2e.email).toMatch(/@example\.invalid$/);
    expect(upgraded.actors.seller_regression.email).toMatch(/@example\.invalid$/);
    expect(upgraded.actors.manager_regression.email).toMatch(/@example\.invalid$/);
    expect(parseManifest(JSON.stringify(upgraded))).toEqual(upgraded);
    expect(() => parseManifest(JSON.stringify({ ...legacy, actors: {
      ...legacy.actors, seller_e2e: { email: 'real@example.com', password: 'invalid' },
    } }))).toThrow(/incompat.vel/);
  });
});
