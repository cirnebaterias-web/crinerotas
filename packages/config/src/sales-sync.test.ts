import { describe, expect, it } from 'vitest';
import { readSalesSheetSyncConfig, readSalesSyncServerConfig } from './sales-sync';
const complete = {
  GOOGLE_SALES_SYNC_ENABLED: 'true', GOOGLE_SALES_SYNC_SPREADSHEET_ID: 'synthetic_sheet_identifier_123',
  GOOGLE_SALES_SYNC_SERVICE_ACCOUNT_EMAIL: 'test@synthetic.iam.gserviceaccount.com',
  GOOGLE_SALES_SYNC_PRIVATE_KEY: 'x'.repeat(100),
  GOOGLE_SALES_SYNC_SCHEDULER_ACTOR_ID: '11111111-1111-4111-8111-111111111111',
};
describe('sales integration configuration', () => {
  it('keeps Google credentials out of the BFF configuration and mandatory for the CLI', () => {
    const server = { ...complete, GOOGLE_SALES_SYNC_SERVICE_ACCOUNT_EMAIL: undefined, GOOGLE_SALES_SYNC_PRIVATE_KEY: undefined };
    expect(readSalesSyncServerConfig(server)).toMatchObject({ configured: true, config: {
      spreadsheetId: complete.GOOGLE_SALES_SYNC_SPREADSHEET_ID, schedulerActorId: complete.GOOGLE_SALES_SYNC_SCHEDULER_ACTOR_ID,
    } });
    expect(readSalesSheetSyncConfig(server)).toEqual({ configured: false, reason: 'missing_configuration' });
    expect(JSON.stringify(readSalesSyncServerConfig(complete))).not.toContain(complete.GOOGLE_SALES_SYNC_PRIVATE_KEY);
    expect(JSON.stringify(readSalesSyncServerConfig(complete))).not.toContain(complete.GOOGLE_SALES_SYNC_SERVICE_ACCOUNT_EMAIL);
  });
  it('defaults disabled and does not interpret absent credentials as active', () => {
    expect(readSalesSheetSyncConfig({})).toEqual({ configured: false, reason: 'disabled' });
    expect(readSalesSheetSyncConfig({ GOOGLE_SALES_SYNC_ENABLED: 'true' }).reason).toBe('missing_configuration');
  });
  it('keeps scheduling disabled unless explicitly enabled and requires a bound actor', () => {
    const state = readSalesSheetSyncConfig(complete);
    expect(state.configured && state.config.scheduleEnabled).toBe(false);
    expect(readSalesSheetSyncConfig({ ...complete, GOOGLE_SALES_SYNC_SCHEDULER_ACTOR_ID: '' }).reason).toBe('missing_configuration');
  });
  it('rejects invalid flags, arbitrary URLs and non-service accounts', () => {
    for (const patch of [{ GOOGLE_SALES_SYNC_ENABLED: 'yes' }, { GOOGLE_SALES_SYNC_SCHEDULE_ENABLED: 'yes' },
      { GOOGLE_SALES_SYNC_SPREADSHEET_ID: 'https://private.example/sheet' },
      { GOOGLE_SALES_SYNC_SERVICE_ACCOUNT_EMAIL: 'person@example.test' }]) {
      expect(readSalesSheetSyncConfig({ ...complete, ...patch }).reason).toBe('invalid_configuration');
    }
  });
});
