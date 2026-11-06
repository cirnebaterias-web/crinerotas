import { parseArgs } from 'node:util';
import { clientSalesQuerySchema, salesSignalsQuerySchema } from '@cirne/contracts';
import { selectIdentityToken } from './identity-input';
import { salesCrmCommand, type SalesCrmCommand } from './sales-crm';

try {
  const { values } = parseArgs({ options: {
    url: { type: 'string', default: process.env.APP_BASE_URL ?? 'http://127.0.0.1:3000' },
    client: { type: 'string' }, seller: { type: 'string' }, clients: { type: 'string' }, date: { type: 'string' },
    generation: { type: 'string' }, 'sales-generation': { type: 'string' }, 'catalog-generation': { type: 'string' },
    'catalog-state': { type: 'string' },
    'as-of': { type: 'string' }, 'client-version': { type: 'string' }, 'history-page': { type: 'string' },
    'opportunity-page': { type: 'string' }, json: { type: 'boolean' },
  }, strict: true });
  let command: SalesCrmCommand;
  if (values.client && !values.seller && !values.clients && !values.date && !values.generation) {
    command = { kind: 'client', clientId: values.client, query: clientSalesQuerySchema.parse({
      salesGenerationId: values['sales-generation'], catalogState: values['catalog-state'],
      catalogGenerationId: values['catalog-generation'],
      asOfDate: values['as-of'],
      clientVersion: values['client-version'],
      historyPage: values['history-page'], opportunityPage: values['opportunity-page'] }) };
  } else if (!values.client && values.seller && values.clients && values.date
      && !values['history-page'] && !values['opportunity-page'] && !values['client-version']
      && !values['sales-generation'] && !values['catalog-state'] && !values['catalog-generation']) {
    command = { kind: 'signals', query: salesSignalsQuerySchema.parse({ generationId: values.generation,
      asOfDate: values['as-of'],
      sellerId: values.seller, serviceDate: values.date, clientIds: values.clients.split(',') }) };
  } else throw new Error();
  let input = '';
  if (!process.env.CIRNE_ACCESS_TOKEN && !process.stdin.isTTY) for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 8192) throw new Error();
  }
  const token = selectIdentityToken(process.env.CIRNE_ACCESS_TOKEN, input);
  console.log(JSON.stringify(await salesCrmCommand(values.url, token, command)));
} catch {
  console.error(JSON.stringify({ schemaVersion: 2, status: 'error',
    message: 'Consulta não concluída. Confira parâmetros, identidade, acesso e disponibilidade do histórico.' }));
  process.exitCode = 1;
}
