'use client';

import { useState } from 'react';
import {
  apiErrorResponseSchema,
  reportExportsPath,
  type ReportExportFormat,
  type ReportExportView,
} from '@cirne/contracts';

const safeFileName = /^cirne-[a-z0-9-]+-\d{4}-\d{2}-\d{2}(?:-a-\d{4}-\d{2}-\d{2})?\.(?:csv|xlsx)$/u;

function responseFileName(response: Response) {
  const disposition = response.headers.get('content-disposition') ?? '';
  const match = /filename="([^"]+)"/u.exec(disposition);
  return match?.[1] && safeFileName.test(match[1]) ? match[1] : null;
}

export function ReportExportActions({ view, filters, disabled = false }: {
  view: ReportExportView;
  filters: Readonly<Record<string, string | undefined>>;
  disabled?: boolean;
}) {
  const [active, setActive] = useState<ReportExportFormat | null>(null);
  const [message, setMessage] = useState('');

  async function download(format: ReportExportFormat) {
    if (active || disabled) return;
    setActive(format); setMessage('');
    try {
      const url = new URL(reportExportsPath, window.location.origin);
      url.searchParams.set('view', view);
      url.searchParams.set('format', format);
      for (const [key, value] of Object.entries(filters)) if (value) url.searchParams.set(key, value);
      const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as unknown;
        const failure = apiErrorResponseSchema.safeParse(body);
        throw new Error(failure.success ? failure.data.error.message : 'Não foi possível gerar o relatório.');
      }
      const fileName = responseFileName(response);
      const contentType = response.headers.get('content-type') ?? '';
      const expectedType = format === 'csv' ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      if (!fileName || !contentType.toLowerCase().startsWith(expectedType)) {
        throw new Error('O servidor retornou um arquivo de relatório inválido.');
      }
      const objectUrl = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a');
      anchor.href = objectUrl; anchor.download = fileName; anchor.hidden = true;
      document.body.append(anchor); anchor.click(); anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
      setMessage(`Relatório ${format.toUpperCase()} gerado.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Não foi possível gerar o relatório.');
    } finally {
      setActive(null);
    }
  }

  return <div className="report-export-actions" aria-label="Exportar relatório">
    <span>Exportar:</span>
    <button type="button" className="seller-button seller-secondary" disabled={disabled || active !== null} onClick={() => void download('csv')}>
      {active === 'csv' ? 'Gerando CSV…' : 'CSV'}
    </button>
    <button type="button" className="seller-button seller-secondary" disabled={disabled || active !== null} onClick={() => void download('xlsx')}>
      {active === 'xlsx' ? 'Gerando XLSX…' : 'XLSX'}
    </button>
    {message && <span className="report-export-message" role="status">{message}</span>}
  </div>;
}
