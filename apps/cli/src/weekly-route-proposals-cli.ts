import { parseArgs } from 'node:util';
import { decidePersistedWeeklyRouteProposal, inspectPersistedWeeklyRouteProposal,
  revisePersistedWeeklyRouteProposal, saveWeeklyRouteProposal, WeeklyRouteProposalCliError,
  weeklyRouteProposalSummary } from './weekly-route-proposals';

async function readInput() {
  let value = '';
  for await (const chunk of process.stdin) value += chunk.toString();
  if (!value.trim()) throw new WeeklyRouteProposalCliError(64, 'Forneça a entrada JSON pela entrada padrão.');
  return JSON.parse(value) as unknown;
}

try {
  const { values } = parseArgs({ options: {
    json: { type: 'boolean', default: false }, url: { type: 'string', default: 'http://127.0.0.1:3000' },
    operation: { type: 'string', default: 'local' }, proposal: { type: 'string' },
  }, strict: true });
  const operation = values.operation;
  if (operation === 'local') {
    console.log(JSON.stringify(weeklyRouteProposalSummary(await readInput())));
  } else {
    const token = process.env.CIRNE_ADMIN_ACCESS_TOKEN?.trim();
    if (!token) throw new WeeklyRouteProposalCliError(64, 'Defina CIRNE_ADMIN_ACCESS_TOKEN.');
    const result = operation === 'generate' ? await saveWeeklyRouteProposal(values.url, token, await readInput())
      : operation === 'inspect' && values.proposal
        ? await inspectPersistedWeeklyRouteProposal(values.url, token, values.proposal)
        : operation === 'revise' && values.proposal
          ? await revisePersistedWeeklyRouteProposal(values.url, token, values.proposal, await readInput())
          : (operation === 'publish' || operation === 'reject') && values.proposal
            ? await decidePersistedWeeklyRouteProposal(values.url, token, values.proposal, await readInput())
            : (() => { throw new WeeklyRouteProposalCliError(64, 'Operação ou --proposal inválido.'); })();
    console.log(values.json ? JSON.stringify(result) : JSON.stringify(result, null, 2));
  }
} catch (error) {
  const failure = error instanceof WeeklyRouteProposalCliError ? error
    : new WeeklyRouteProposalCliError(64, error instanceof Error ? error.message : 'Entrada inválida.');
  console.error(JSON.stringify({ status: 'error', message: failure.message }));
  process.exitCode = failure.exitCode;
}
