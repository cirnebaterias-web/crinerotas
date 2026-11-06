import type { CanonicalRoute } from '@cirne/contracts';

export function orderPendingFromLocation(stops: CanonicalRoute['stops'], origin: { latitude: number; longitude: number }) {
  const radians = (value: number) => value * Math.PI / 180;
  const distance = (stop: CanonicalRoute['stops'][number]) => {
    const latitude = Number(stop.client.latitude); const longitude = Number(stop.client.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return Number.POSITIVE_INFINITY;
    const dLat = radians(latitude - origin.latitude); const dLng = radians(longitude - origin.longitude);
    const value = Math.sin(dLat / 2) ** 2 + Math.cos(radians(origin.latitude)) * Math.cos(radians(latitude))
      * Math.sin(dLng / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
  };
  const pending = stops.filter((stop) => stop.status === 'pending').sort((left, right) =>
    distance(left) - distance(right) || left.executionOrder - right.executionOrder);
  let index = 0;
  return stops.map((stop) => stop.status === 'pending' ? pending[index++]! : stop);
}
