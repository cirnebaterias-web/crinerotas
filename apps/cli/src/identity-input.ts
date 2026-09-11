export function selectIdentityToken(environmentToken: string | undefined, standardInput: string) {
  const fromEnvironment = environmentToken?.trim() ?? '';
  const fromInput = standardInput.trim();
  if (fromEnvironment && fromInput) {
    throw new Error('Forneça o token por apenas uma origem: stdin ou CIRNE_ACCESS_TOKEN.');
  }
  const token = fromInput || fromEnvironment;
  if (!token) throw new Error('Token ausente. Use stdin ou CIRNE_ACCESS_TOKEN.');
  return token;
}
