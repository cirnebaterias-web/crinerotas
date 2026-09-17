import { describe, expect, it } from 'vitest';
import { buildGoogleMapsUrl } from './navigation';

const address = 'Rua São José, 100 & loja #2 — Recife, PE';
const client = { address, latitude: null, longitude: null };

describe('Google Maps destination', () => {
  it('encodes the address as one parameter with fixed origin and no API key', () => {
    const url = new URL(buildGoogleMapsUrl(client)!);
    expect(url.origin + url.pathname).toBe('https://www.google.com/maps/dir/');
    expect([...url.searchParams]).toEqual([['api', '1'], ['destination', address]]);
    expect(url.hash).toBe('');
  });

  it.each([
    ['0', '0', '0,0'], ['-8.063', '-34.871', '-8.063,-34.871'],
    ['90', '180', '90,180'], ['-90', '-180', '-90,-180'],
  ])('prefers valid coordinates %s / %s', (latitude, longitude, destination) => {
    const input = Object.freeze({ address, latitude, longitude });
    expect(new URL(buildGoogleMapsUrl(input)!).searchParams.get('destination')).toBe(destination);
  });

  it.each([
    [null, '-34'], ['-8', null], ['91', '0'], ['0', '181'], ['-91', '0'], ['0', '-181'],
    ['', '0'], ['NaN', '0'], ['Infinity', '0'], ['0x10', '0'], [' ', '0'], ['1e2', '0'],
  ])('falls back to address for invalid/partial coordinates %s / %s', (latitude, longitude) => {
    expect(new URL(buildGoogleMapsUrl({ address, latitude, longitude })!).searchParams.get('destination')).toBe(address);
  });

  it('does not allow a destination to change URL origin or inject parameters', () => {
    const destination = 'https://evil.example/?origin=other&api=2#fragment';
    const url = new URL(buildGoogleMapsUrl({ ...client, address: destination })!);
    expect(url.hostname).toBe('www.google.com');
    expect([...url.searchParams.keys()]).toEqual(['api', 'destination']);
    expect(url.searchParams.get('destination')).toBe(destination);
  });

  it('rejects blank destinations and URLs exceeding the provider limit', () => {
    expect(buildGoogleMapsUrl({ ...client, address: ' \n ' })).toBeNull();
    expect(buildGoogleMapsUrl({ ...client, address: 'ã'.repeat(400) })).toBeNull();
    expect(buildGoogleMapsUrl({ address: '', latitude: '0', longitude: '0' })).not.toBeNull();
  });
});
