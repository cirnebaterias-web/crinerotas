import type { CanonicalRoute } from '@cirne/contracts';

export type NavigationDestination = Pick<CanonicalRoute['stops'][number]['client'], 'address' | 'latitude' | 'longitude'>;

function coordinate(value: string | null, limit: number): number | null {
  if (value === null || !/^-?\d+(?:\.\d+)?$/.test(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) <= limit ? number : null;
}

/** Builds a destination-only URL; no network, geolocation or visit mutation. */
export function buildGoogleMapsUrl(client: NavigationDestination): string | null {
  const latitude = coordinate(client.latitude, 90);
  const longitude = coordinate(client.longitude, 180);
  const destination = latitude !== null && longitude !== null
    ? `${latitude},${longitude}` : client.address.trim();
  if (!destination) return null;
  const url = new URL('https://www.google.com/maps/dir/');
  url.searchParams.set('api', '1');
  url.searchParams.set('destination', destination);
  const result = url.toString();
  return result.length <= 2048 ? result : null;
}
