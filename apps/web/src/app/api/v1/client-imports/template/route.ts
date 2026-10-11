import ExcelJS from 'exceljs';
import { clientImportHeaders } from '@cirne/contracts';
import { handleClientImportRequest, requireClientCapability } from '@/server/client-imports/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  return handleClientImportRequest(request, '/api/v1/client-imports/template', async ({ identity }, headers) => {
    requireClientCapability(identity, 'clients.import');
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Clientes', { views: [{ state: 'frozen', ySplit: 1 }] });
    sheet.addRow([...clientImportHeaders]);
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF17324D' } };
    sheet.columns = [{ width: 23 }, { width: 34 }, { width: 44 }, { width: 14 }, { width: 14 },
      { width: 24 }, { width: 34 }, { width: 14 }];
    sheet.getColumn(4).numFmt = '0.000000';
    sheet.getColumn(5).numFmt = '0.000000';
    sheet.autoFilter = { from: 'A1', to: 'H1' };
    const buffer = await workbook.xlsx.writeBuffer();
    headers.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    headers.set('Content-Disposition', 'attachment; filename="modelo-clientes-cirne.xlsx"');
    return new Response(buffer as ArrayBuffer, { headers });
  });
}
