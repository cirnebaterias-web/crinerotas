import { parseArgs } from 'node:util';
import {
  downloadReportExport,
  ReportExportCliError,
  resolveReportExportQuery,
} from './report-exports';

async function stdin() {
  let value = '';
  if (!process.stdin.isTTY) for await (const chunk of process.stdin) value += chunk;
  return value.trim();
}

try {
  const { values } = parseArgs({
    options: {
      url: { type: 'string', default: 'http://127.0.0.1:3000' },
      view: { type: 'string' }, format: { type: 'string' }, output: { type: 'string' },
      'service-date': { type: 'string' }, section: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' },
      status: { type: 'string' }, period: { type: 'string' }, 'seller-id': { type: 'string' },
      'client-id': { type: 'string' }, 'competitor-id': { type: 'string' }, 'action-type': { type: 'string' },
      json: { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (!values.output) throw new ReportExportCliError(64, 'Informe --output com o caminho local do novo arquivo.');
  const token = process.env.CIRNE_MANAGER_ACCESS_TOKEN?.trim() || await stdin();
  if (!token) throw new ReportExportCliError(77, 'Forneça o token do Gestor por stdin ou CIRNE_MANAGER_ACCESS_TOKEN.');
  const query = resolveReportExportQuery({
    view: values.view, format: values.format, serviceDate: values['service-date'], section: values.section,
    from: values.from, to: values.to, status: values.status, period: values.period,
    sellerId: values['seller-id'], clientId: values['client-id'], competitorId: values['competitor-id'],
    actionType: values['action-type'],
  });
  const result = await downloadReportExport({ baseUrl: values.url, token, query, outputPath: values.output });
  console.log(values.json ? JSON.stringify({ schemaVersion: 1, status: 'ok', ...result })
    : `Relatório salvo em ${result.outputPath} (${result.rowCount} linha(s), ${result.bytes} bytes).`);
} catch (error) {
  const parseError = error instanceof Error && 'code' in error &&
    typeof error.code === 'string' && error.code.startsWith('ERR_PARSE_ARGS_');
  const failure = error instanceof ReportExportCliError ? error
    : parseError ? new ReportExportCliError(64, 'Os argumentos informados são inválidos.')
      : new ReportExportCliError(69, 'Não foi possível exportar o relatório.');
  console.error(process.argv.includes('--json')
    ? JSON.stringify({ schemaVersion: 1, status: 'error', message: failure.message }) : failure.message);
  process.exitCode = failure.exitCode;
}
