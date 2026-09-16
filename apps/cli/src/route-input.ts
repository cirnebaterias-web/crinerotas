export interface RouteTokens {
  managerAccessToken: string;
  sellerAccessToken: string;
}

function parseStandardInput(value: string): RouteTokens | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error('stdin inválido: informe JSON com managerAccessToken e sellerAccessToken.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) ||
      Object.keys(parsed).sort().join(',') !== 'managerAccessToken,sellerAccessToken') {
    throw new Error('stdin inválido: informe somente managerAccessToken e sellerAccessToken.');
  }
  const input = parsed as Record<string, unknown>;
  if (typeof input.managerAccessToken !== 'string' || !input.managerAccessToken.trim() ||
      typeof input.sellerAccessToken !== 'string' || !input.sellerAccessToken.trim()) {
    throw new Error('Tokens de Gestor e Vendedor são obrigatórios.');
  }
  return {
    managerAccessToken: input.managerAccessToken.trim(),
    sellerAccessToken: input.sellerAccessToken.trim(),
  };
}

export function selectRouteTokens(
  managerEnvironmentToken: string | undefined,
  sellerEnvironmentToken: string | undefined,
  standardInput: string,
): RouteTokens {
  const fromInput = parseStandardInput(standardInput);
  const managerAccessToken = managerEnvironmentToken?.trim() ?? '';
  const sellerAccessToken = sellerEnvironmentToken?.trim() ?? '';
  if (fromInput && (managerAccessToken || sellerAccessToken)) {
    throw new Error('Forneça os tokens por apenas uma origem: stdin ou ambiente.');
  }
  if (fromInput) return fromInput;
  if (!managerAccessToken || !sellerAccessToken) {
    throw new Error('Use CIRNE_MANAGER_ACCESS_TOKEN e CIRNE_SELLER_ACCESS_TOKEN, ou stdin JSON.');
  }
  return { managerAccessToken, sellerAccessToken };
}
