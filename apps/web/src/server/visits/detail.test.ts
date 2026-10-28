import { describe, expect, it, vi } from 'vitest';
import type { MeResponse, VisitDetailResponse } from '@cirne/contracts';
import {
  createVisitAttachmentDownloadUrl,
  getVisitDetail,
  type VisitAttachmentDownloadRepository,
  type VisitDetailRepository,
} from './service';
import { SupabaseVisitRepository } from './supabase-repository';

const id = '11111111-1111-4111-8111-111111111111';
const requestId = '22222222-2222-4222-8222-222222222222';
const at = '2026-10-26T12:00:00.000Z';
const manager: MeResponse = {
  id: '33333333-3333-4333-8333-333333333333', displayName: 'Gestora', status: 'active',
  roles: ['manager'], capabilities: ['route.read_scoped'], scopeIds: [id],
};
const detail: VisitDetailResponse = {
  schemaVersion: 1, visitId: id,
  context: { serviceDate: '2026-10-26', route: { id, versionId: id, versionNumber: 1 },
    stop: { id, plannedOrder: 1, priority: 0 }, client: { id, externalReference: null, name: 'Cliente', address: 'Rua A' },
    seller: { id, displayName: 'Vendedor' }, parameterSet: { id, version: 1 } },
  status: 'in_progress', deviceStartedAt: at, serverStartedAt: at, deviceCompletedAt: null,
  serverCompletedAt: null, lastKnownUpdateAt: at,
  serverVisibilityNote: 'Somente dados recebidos e confirmados pelo servidor estão presentes; conteúdo ainda apenas no aparelho não é conhecido.',
  sections: { stock: { state: 'absent' }, competitorPrices: { state: 'absent' }, commercialActions: { state: 'absent' }, scrap: { state: 'absent' }, result: { state: 'absent' } },
  synchronization: { status: 'confirmed', occurredAt: at, receivedAt: at, confirmedAt: at, attemptCount: 1, lastErrorCode: null },
  exceptions: [], location: { state: 'withheld' }, evidence: { state: 'withheld' }, timeline: [],
};

describe('visit detail service', () => {
  it('allows only an in-scope manager capability and validates the canonical response', async () => {
    const repository: VisitDetailRepository = { getDetail: vi.fn().mockResolvedValue(detail) };
    await expect(getVisitDetail(manager, id, requestId, repository)).resolves.toEqual(detail);
    expect(repository.getDetail).toHaveBeenCalledWith(id, requestId);
  });

  it('rejects seller, empty scope and malformed UUID before the repository', async () => {
    const repository: VisitDetailRepository = { getDetail: vi.fn() };
    await expect(getVisitDetail({ ...manager, roles: ['seller'] }, id, requestId, repository))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(getVisitDetail({ ...manager, scopeIds: [] }, id, requestId, repository))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(getVisitDetail(manager, 'offline-reference', requestId, repository))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(repository.getDetail).not.toHaveBeenCalled();
  });

  it('fails closed when the repository returns a sensitive extra field', async () => {
    const repository: VisitDetailRepository = {
      getDetail: vi.fn().mockResolvedValue({ ...detail, storagePath: 'private/path.jpg' }),
    };
    await expect(getVisitDetail(manager, id, requestId, repository))
      .rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
  });

  it('requires the distinct evidence capability before authorizing a URL', async () => {
    const repository: VisitAttachmentDownloadRepository = {
      createDownloadUrl: vi.fn().mockResolvedValue({
        schemaVersion: 1, attachmentId: id, url: 'https://example.invalid/signed', expiresInSeconds: 60,
      }),
    };
    await expect(createVisitAttachmentDownloadUrl(manager, id, requestId, repository))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(createVisitAttachmentDownloadUrl(
      { ...manager, capabilities: [...manager.capabilities, 'visit.evidence.read_scoped'] },
      id, requestId, repository,
    )).resolves.toMatchObject({ attachmentId: id, expiresInSeconds: 60 });
  });

  it('maps a thrown storage signing failure to a recoverable dependency error', async () => {
    const abortSignal = vi.fn().mockResolvedValue({
      data: { bucket: 'visit-evidence', storagePath: 'synthetic/evidence.jpg', expiresInSeconds: 60 },
      error: null,
    });
    const client = {
      schema: vi.fn().mockReturnValue({ rpc: vi.fn().mockReturnValue({ abortSignal }) }),
      storage: {
        from: vi.fn().mockReturnValue({
          createSignedUrl: vi.fn().mockRejectedValue(new Error('storage unavailable')),
        }),
      },
    };
    const repository = new SupabaseVisitRepository(client as never);
    await expect(repository.createDownloadUrl(id, requestId)).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
      recoverable: true,
    });
  });
});
