import { readServerConfig } from '@cirne/config/server';
import { reportExportQuerySchema, reportExportsPath, type ReportExportFormat, type ReportExportView } from '@cirne/contracts';
import { randomUUID } from 'node:crypto';
import { createLogger, logReportExport } from '@/server/logging';
import { createReportExport } from '@/server/report-exports/service';
import {
  mapRouteRequestError, resolveRouteRequest, routeErrorResponse, routeResponseHeaders, RouteRequestError,
} from '@/server/routes/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const startedAt = performance.now();
  const requestId = randomUUID();
  const headers = routeResponseHeaders(requestId);
  let status = 200;
  let view: ReportExportView | null = null;
  let format: ReportExportFormat | null = null;
  let rowCount: number | null = null;
  try {
    const parameters = new URL(request.url).searchParams;
    const supplied = [...parameters.keys()];
    if (supplied.some((key) => parameters.getAll(key).length !== 1)) {
      throw new RouteRequestError(422, 'VALIDATION_FAILED', 'Filtro de exportação repetido.', false);
    }
    const parsed = reportExportQuerySchema.safeParse(Object.fromEntries(parameters.entries()));
    if (!parsed.success) {
      throw new RouteRequestError(
        422, 'VALIDATION_FAILED', parsed.error.issues[0]?.message ?? 'Filtros de exportação inválidos.', false,
      );
    }
    view = parsed.data.view;
    format = parsed.data.format;
    const { identity, client } = await resolveRouteRequest(request, headers);
    const operationalTimeZone = readServerConfig(process.env).OPERATIONAL_TIME_ZONE;
    const result = await createReportExport({ identity, query: parsed.data, operationalTimeZone, client });
    rowCount = result.metadata.rowCount;
    headers.set('Content-Type', result.metadata.contentType);
    headers.set('Content-Disposition', `attachment; filename="${result.metadata.fileName}"`);
    headers.set('Cache-Control', 'private, no-store');
    headers.set('X-Export-View', result.metadata.view);
    headers.set('X-Export-Row-Count', String(result.metadata.rowCount));
    return new Response(result.bytes, { status, headers });
  } catch (error) {
    const publicError = mapRouteRequestError(error);
    status = publicError.status;
    return routeErrorResponse(publicError, requestId, headers);
  } finally {
    try {
      const config = readServerConfig(process.env);
      logReportExport(createLogger(config.LOG_LEVEL), {
        requestId, routeTemplate: reportExportsPath, method: 'GET', status,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        view, format, rowCount,
      });
    } catch {
      // Logging cannot replace the prepared response.
    }
  }
}
