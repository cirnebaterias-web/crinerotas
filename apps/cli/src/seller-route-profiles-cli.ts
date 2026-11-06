import { parseArgs } from 'node:util';
import { getSellerRouteProfile, SellerRouteProfileCliError, updateSellerRouteProfile } from './seller-route-profiles';

async function stdin() { let value = ''; if (!process.stdin.isTTY) for await (const chunk of process.stdin) value += chunk; return value.trim(); }

try {
  const { values } = parseArgs({ options: { url: { type: 'string', default: 'http://127.0.0.1:3000' },
    seller: { type: 'string' }, command: { type: 'string' }, json: { type: 'boolean', default: false } }, strict: true });
  const token = process.env.CIRNE_ADMIN_ACCESS_TOKEN?.trim() || await stdin();
  if (!token || !values.seller) throw new SellerRouteProfileCliError(64, 'Informe token e --seller.');
  const result = values.command
    ? await updateSellerRouteProfile(values.url, token, values.seller, JSON.parse(values.command))
    : await getSellerRouteProfile(values.url, token, values.seller);
  console.log(values.json ? JSON.stringify(result) : JSON.stringify(result, null, 2));
} catch (error) {
  const failure = error instanceof SellerRouteProfileCliError ? error
    : new SellerRouteProfileCliError(64, 'Comando de perfil operacional invalido.');
  console.error(failure.message); process.exitCode = failure.exitCode;
}
