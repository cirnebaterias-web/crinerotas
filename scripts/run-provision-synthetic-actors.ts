import { actorKeys, provisionSyntheticActors } from './provision-synthetic-actors';

const json = process.argv.includes('--json');
try {
  const actors = await provisionSyntheticActors();
  const publicResult = { ok: true, actors };
  console.log(json ? JSON.stringify(publicResult) :
    `Atores sintéticos provisionados: ${actorKeys.join(', ')}. Credenciais protegidas em .local/identity-actors.json.`);
} catch (error) {
  const message = error instanceof Error ? error.message : 'Falha desconhecida no provisionamento sintético.';
  console.error(json ? JSON.stringify({ ok: false, message }) : message);
  process.exitCode = 1;
}
