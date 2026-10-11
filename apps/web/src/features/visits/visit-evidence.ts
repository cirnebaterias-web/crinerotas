import type { VisitEvidenceIssue } from '@cirne/contracts';

export const VISIT_RADIUS_M = 100;
export const DESIRED_GPS_ACCURACY_M = 50;

export function distanceMeters(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
) {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const radius = 6_371_000;
  const latitudeDelta = radians(to.latitude - from.latitude);
  const longitudeDelta = radians(to.longitude - from.longitude);
  const value = Math.sin(latitudeDelta / 2) ** 2 + Math.cos(radians(from.latitude)) *
    Math.cos(radians(to.latitude)) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * radius * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

export function locationAssessment(input: {
  latitude: number;
  longitude: number;
  accuracyM: number;
  clientLatitude: string | null;
  clientLongitude: string | null;
}) {
  const issues: VisitEvidenceIssue[] = [];
  if (input.accuracyM > DESIRED_GPS_ACCURACY_M) issues.push('gps_low_accuracy');
  if (input.clientLatitude === null || input.clientLongitude === null) {
    issues.push('client_location_missing');
    return { issues, distanceM: undefined };
  }
  const distanceM = distanceMeters(
    { latitude: input.latitude, longitude: input.longitude },
    { latitude: Number(input.clientLatitude), longitude: Number(input.clientLongitude) },
  );
  if (distanceM > VISIT_RADIUS_M) issues.push('outside_radius');
  return { issues, distanceM };
}

export function evidenceIssueLabel(issue: VisitEvidenceIssue) {
  return ({
    camera_unavailable: 'Câmera indisponível',
    gps_unavailable: 'GPS indisponível',
    gps_low_accuracy: 'Precisão do GPS acima de 50 m',
    outside_radius: 'Posição fora do raio de 100 m',
    client_location_missing: 'Loja sem coordenadas cadastradas',
  } as const)[issue];
}
