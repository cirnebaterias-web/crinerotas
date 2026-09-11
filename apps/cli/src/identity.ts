import { apiErrorResponseSchema, mePath, meResponseSchema } from '@cirne/contracts';

function parseOrigin(baseUrl: string) {
  try {
    const url = new URL(baseUrl);
    const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
    if (!['http:', 'https:'].includes(url.protocol) || !loopbackHosts.has(url.hostname) ||
        url.username || url.password ||
        url.search || url.hash || url.pathname !== '/') throw new Error();
    return url;
  } catch {
    throw new Error('URL inválida: informe uma origem HTTP(S), sem credenciais ou parâmetros.');
  }
}

export async function checkIdentity(baseUrl: string, token: string, request: typeof fetch = fetch) {
  if (!token.trim()) throw new Error('Token ausente. Use stdin ou CIRNE_ACCESS_TOKEN.');
  let response: Response;
  try {
    response = await request(new URL(mePath, parseOrigin(baseUrl)), {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('URL inválida:')) throw error;
    throw new Error('Aplicação inacessível ou timeout. Confira o endereço e se o servidor está iniciado.');
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error('Resposta de identidade incompatível com o contrato.');
  }
  if (!response.ok) {
    const parsedError = apiErrorResponseSchema.safeParse(body);
    if (!parsedError.success) throw new Error(`Identidade retornou HTTP ${response.status}.`);
    throw new Error(`${parsedError.data.error.message} (HTTP ${response.status}).`);
  }
  try {
    return meResponseSchema.parse(body);
  } catch {
    throw new Error('Resposta de identidade incompatível com o contrato.');
  }
}
