import { parseArgs } from 'node:util';
import { buildGoogleMapsUrl } from '@cirne/domain';

const json = process.argv.includes('--json');
try {
  parseArgs({ options: { json: { type: 'boolean' } }, strict: true, allowPositionals: false });
  const address = 'Rua de demonstração, 100 — Recife, PE';
  const byAddress = buildGoogleMapsUrl({ address, latitude: null, longitude: null });
  const byCoordinates = buildGoogleMapsUrl({ address, latitude: '0', longitude: '0' });
  const fallback = buildGoogleMapsUrl({ address, latitude: '91', longitude: '0' });
  const checks = {
    encodedAddress: byAddress !== null && new URL(byAddress).searchParams.get('destination') === address,
    coordinates: byCoordinates !== null && new URL(byCoordinates).searchParams.get('destination') === '0,0',
    invalidCoordinatesFallback: fallback === byAddress,
    emptyRejected: buildGoogleMapsUrl({ address: '', latitude: null, longitude: null }) === null,
  };
  if (!Object.values(checks).every(Boolean)) throw new Error('Navigation check failed');
  console.log(json ? JSON.stringify({ status: 'ok', synthetic: true, networkRequests: 0, checks })
    : 'OK: destino por endereço/coordenadas e fallback validados; diagnóstico sintético sem rede.');
} catch (error) {
  const message = error instanceof Error && error.message === 'Navigation check failed'
    ? 'Diagnóstico falhou: destino ou fallback de navegação inválido.'
    : 'Diagnóstico inválido. Use apenas --json.';
  console.error(json ? JSON.stringify({ status: 'error', message }) : message);
  process.exitCode = 1;
}
