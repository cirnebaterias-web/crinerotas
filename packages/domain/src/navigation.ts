import { googlePlaceIdSchema, type CanonicalRoute } from '@cirne/contracts';

export type NavigationDestination = Pick<CanonicalRoute['stops'][number]['client'], 'address' | 'latitude' | 'longitude' | 'googleLocation'>;

export function navigationAddress(client: Pick<NavigationDestination, 'address' | 'googleLocation'>): string {
  return client.googleLocation?.address?.trim() || client.address.trim();
}

function coordinate(value: string | null, limit: number): number | null {
  if (value === null || !/^-?\d+(?:\.\d+)?$/.test(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) <= limit ? number : null;
}

/** Builds a destination-only URL; no network, geolocation or visit mutation. */
export function buildGoogleMapsUrl(client: NavigationDestination): string | null {
  const latitude = coordinate(client.latitude, 90);
  const longitude = coordinate(client.longitude, 180);
  const placeId = googlePlaceIdSchema.safeParse(client.googleLocation?.placeId);
  const destination = placeId.success || client.googleLocation?.address?.trim()
    ? navigationAddress(client)
    : latitude !== null && longitude !== null
      ? `${latitude},${longitude}` : client.address.trim();
  if (!destination) return null;
  const url = new URL('https://www.google.com/maps/dir/');
  url.searchParams.set('api', '1');
  url.searchParams.set('destination', destination);
  if (placeId.success) url.searchParams.set('destination_place_id', placeId.data);
  const result = url.toString();
  return result.length <= 2048 ? result : null;
}
