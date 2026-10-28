import { expect, test } from '@playwright/test';

const visitId = '60000000-0000-4000-8000-000000000001';
const entityId = '60000000-0000-4000-8000-000000000002';
const evidenceId = '60000000-0000-4000-8000-000000000003';
const at = '2026-10-26T12:00:00.000Z';

const detail = {
  schemaVersion: 1,
  visitId,
  context: {
    serviceDate: '2026-10-26',
    route: { id: entityId, versionId: entityId, versionNumber: 2 },
    stop: { id: entityId, plannedOrder: 3, priority: 1 },
    client: { id: entityId, externalReference: null, name: 'Cliente Visitado', address: 'Rua Sintetica' },
    seller: { id: entityId, displayName: 'Vendedor Sintetico' },
    parameterSet: { id: entityId, version: 1 },
  },
  status: 'completed',
  deviceStartedAt: at,
  serverStartedAt: at,
  deviceCompletedAt: at,
  serverCompletedAt: at,
  lastKnownUpdateAt: at,
  serverVisibilityNote: 'Somente dados recebidos e confirmados pelo servidor estão presentes; conteúdo ainda apenas no aparelho não é conhecido.',
  sections: {
    stock: { state: 'absent' },
    competitorPrices: { state: 'unknown_to_server' },
    commercialActions: { state: 'absent' },
    scrap: {
      state: 'available', recordedAt: at, availability: 'scheduled',
      collectedWeightKg: null, scheduledWeightKg: '15.500', collection: null,
      schedule: { id: entityId, desiredDate: '2026-10-27', period: 'morning', status: 'pending', observation: null },
    },
    result: { state: 'available', outcome: 'completed', deviceCompletedAt: at, serverCompletedAt: at },
  },
  synchronization: {
    status: 'confirmed', occurredAt: at, receivedAt: at, confirmedAt: at,
    attemptCount: 1, lastErrorCode: null,
  },
  exceptions: [{
    kind: 'gps_unavailable',
    message: 'A localizacao nao estava disponivel; a visita continuou com justificativa.',
    capturedAt: at,
  }],
  location: { state: 'withheld' },
  evidence: { state: 'withheld' },
  timeline: [],
};

test.describe('authorized visit detail experience', () => {
  test.use({ serviceWorkers: 'block' });

  test('loads the confirmed detail, keeps sensitive data withheld and preserves it on refresh failure', async ({ page }) => {
    let response: 'ready' | 'error' = 'ready';
    await page.route(`**/api/v1/visits/${visitId}`, async (route) => {
      if (response === 'error') {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({
            error: {
              code: 'DEPENDENCY_UNAVAILABLE',
              message: 'Detalhe temporariamente indisponivel.',
              recoverable: true,
              timestamp: at,
              requestId: entityId,
            },
          }),
        });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(detail) });
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/management/visits/${visitId}`);
    await expect(page.getByText(/Visita indispon.vel\./u)).toBeVisible();

    await page.getByRole('button', { name: 'Atualizar agora' }).click();
    await expect(page.getByRole('heading', { name: 'Cliente Visitado' })).toBeVisible();
    await expect(page.getByText('15.500')).toBeVisible();
    await expect(page.getByText(/N.o conhecido pelo servidor/u)).toBeVisible();
    await expect(page.getByText(/Oculto por permiss.o/u)).toHaveCount(2);
    await expect(page.getByText('Latitude')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('storagePath');
    await expect(page.locator('body')).not.toContainText('signedUrl');

    response = 'error';
    await page.getByRole('button', { name: 'Atualizar agora' }).click();
    const alert = page.getByRole('alert').filter({ hasText: 'Detalhe temporariamente indisponivel.' });
    await expect(alert).toContainText('Detalhe temporariamente indisponivel.');
    await expect(alert).toBeFocused();
    await expect(page.getByRole('heading', { name: 'Cliente Visitado' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test('opens an explicitly authorized evidence URL from a synchronously created window', async ({ page }) => {
    const detailWithEvidence = {
      ...detail,
      evidence: {
        state: 'available',
        items: [{
          id: evidenceId,
          purpose: 'visit_checkin',
          contentType: 'image/jpeg',
          byteSize: 1024,
          capturedAt: at,
          verifiedAt: at,
          downloadUrlPath: `/api/v1/attachments/${evidenceId}/download-url`,
        }],
      },
    };
    await page.route(`**/api/v1/visits/${visitId}`, async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(detailWithEvidence) });
    });
    await page.route(`**/api/v1/attachments/${evidenceId}/download-url`, async (route) => {
      const temporaryUrl = `${new URL(route.request().url()).origin}/temporary-evidence`;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ schemaVersion: 1, attachmentId: evidenceId, url: temporaryUrl, expiresInSeconds: 60 }),
      });
    });
    await page.route('**/temporary-evidence', async (route) => {
      await route.fulfill({ status: 200, contentType: 'text/plain', body: 'synthetic evidence' });
    });

    await page.goto(`/management/visits/${visitId}`);
    await page.getByRole('button', { name: 'Atualizar agora' }).click();
    const popupPromise = page.waitForEvent('popup');
    await page.getByRole('button', { name: 'Abrir por 60 s' }).click();
    const popup = await popupPromise;
    await expect(popup).toHaveURL(/\/temporary-evidence$/u);
    await expect(page.getByRole('status')).toContainText('60 segundos');
    expect(await popup.evaluate(() => window.opener)).toBeNull();
  });
});
