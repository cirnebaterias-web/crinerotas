import { livePath, liveResponseSchema } from '@cirne/contracts';

export async function checkLive(baseUrl: string, request: typeof fetch = fetch) {
  let url: URL;
  try {
    url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
  } catch { throw new Error('URL inválida: informe uma origem HTTP(S), sem credenciais ou parâmetros.'); }
  let response: Response;
  try {
    response = await request(new URL(livePath, url), { redirect: 'error', signal: AbortSignal.timeout(5000) });
  } catch { throw new Error('Aplicação inacessível ou timeout. Confira o endereço e se o servidor está iniciado.'); }
  if (!response.ok) throw new Error(`Health retornou HTTP ${response.status}.`);
  try {
    return liveResponseSchema.parse(await response.json());
  } catch { throw new Error('Resposta de saúde incompatível com o contrato.'); }
}
