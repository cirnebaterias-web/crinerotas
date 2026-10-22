import { describe, expect, it, vi } from 'vitest';
import { managementDayPath } from '@cirne/contracts';
import {
  ManagementDayCliError,
  managementDayExitCodes,
  resolveManagementDate,
  runManagementDayCommand,
} from './management-day';

const response = {
  schemaVersion: 1 as const,
  serviceDate: '2026-10-20',
  generatedAt: '2026-10-20T12:00:00.000Z',
  lastKnownUpdateAt: null,
  availability: 'empty' as const,
  totals: { planned: 0, pending: 0, inVisit: 0, completed: 0, notVisited: 0 },
  sync: { pending: 0, errors: 0, oldestPendingAt: null, lastKnownAt: null },
  routes: [],
  serverVisibilityNote: 'Somente eventos recebidos pelo servidor estão incluídos; itens ainda apenas no aparelho não são visíveis.' as const,
};

describe('management day CLI', () => {
  it('uses the injected clock and operational time zone', () => {
    const clock = { now: () => new Date('2026-10-21T01:30:00.000Z') };
    expect(resolveManagementDate(undefined, 'America/Recife', clock)).toBe('2026-10-20');
  });

  it('rejects an invalid date before making a request', async () => {
    const request = vi.fn();
    await expect(runManagementDayCommand({ baseUrl: 'http://localhost:3000', token: 'private',
      date: '20/10/2026', timeZone: 'America/Recife', json: true, request }))
      .rejects.toMatchObject({ exitCode: managementDayExitCodes.invalidArgument });
    expect(request).not.toHaveBeenCalled();
  });

  it('returns stable JSON and the meaningful empty exit code without exposing the token', async () => {
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      expect(url.pathname).toBe(managementDayPath);
      expect(url.searchParams.get('serviceDate')).toBe('2026-10-20');
      expect(init?.headers).toEqual({ authorization: 'Bearer private' });
      return Response.json(response);
    });
    const result = await runManagementDayCommand({ baseUrl: 'http://localhost:3000', token: 'private',
      date: '2026-10-20', timeZone: 'America/Recife', json: true, request });
    expect(result.exitCode).toBe(managementDayExitCodes.empty);
    expect(JSON.parse(result.output)).toEqual(response);
    expect(result.output).not.toContain('private');
  });

  it.each([[403, 77], [422, 64], [503, 69]])('maps HTTP %i to exit code %i', async (status, exitCode) => {
    const request = vi.fn(async () => Response.json({ error: { code: 'FORBIDDEN', message: 'Negado.',
      recoverable: false, timestamp: '2026-10-20T12:00:00.000Z',
      requestId: '10000000-0000-4000-8000-000000000001' } }, { status }));
    try {
      await runManagementDayCommand({ baseUrl: 'http://localhost:3000', token: 'private',
        date: '2026-10-20', timeZone: 'America/Recife', json: false, request });
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(ManagementDayCliError);
      expect((error as ManagementDayCliError).exitCode).toBe(exitCode);
    }
  });
});
