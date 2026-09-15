import {
  apiErrorResponseSchema,
  syncBatchPath,
  syncBatchExchangeSchema,
  syncErrorCodeSchema,
  type SyncBatchRequest,
  type SyncBatchResponse,
  type SyncErrorCode,
} from '@cirne/contracts';

export class SyncTransportError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: SyncErrorCode,
  ) {
    super(code);
  }
}

export interface SyncTransport {
  send(batch: SyncBatchRequest): Promise<SyncBatchResponse>;
}

export class FetchSyncTransport implements SyncTransport {
  async send(batch: SyncBatchRequest) {
    let response: Response;
    try {
      response = await fetch(syncBatchPath, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': 'cirne-sync-v1',
        },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new SyncTransportError(0, 'DEPENDENCY_UNAVAILABLE');
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new SyncTransportError(response.status, 'DEPENDENCY_UNAVAILABLE');
    }
    if (!response.ok) {
      const parsed = apiErrorResponseSchema.safeParse(body);
      const parsedCode = parsed.success ? syncErrorCodeSchema.safeParse(parsed.data.error.code) : null;
      const code = parsedCode?.success ? parsedCode.data : 'INTERNAL_ERROR';
      throw new SyncTransportError(response.status, code);
    }
    const parsed = syncBatchExchangeSchema.safeParse({ request: batch, response: body });
    if (!parsed.success) throw new SyncTransportError(502, 'DEPENDENCY_UNAVAILABLE');
    return parsed.data.response;
  }
}
