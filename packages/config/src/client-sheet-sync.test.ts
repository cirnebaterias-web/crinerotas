import { describe, expect, it } from 'vitest';
import { readClientPortfolioMappings, readClientSheetSyncConfig } from './client-sheet-sync';
const env = { GOOGLE_CLIENT_SYNC_ENABLED: 'true', GOOGLE_CLIENT_SYNC_SPREADSHEET_ID: 'synthetic-sheet-id-000001',
  GOOGLE_CLIENT_SYNC_SERVICE_ACCOUNT_EMAIL: 'test@synthetic.iam.gserviceaccount.com',
  GOOGLE_CLIENT_SYNC_PRIVATE_KEY: 'synthetic-not-a-real-key'.repeat(10),
  GOOGLE_CLIENT_SYNC_PORTFOLIOS_JSON: '{" teste ":"seller@example.invalid"}' };
describe('private Google sync config', () => {
  it('starts disabled and does not expose supplied values on failure', () => {
    expect(readClientSheetSyncConfig({})).toEqual({ configured: false, reason: 'disabled' });
    expect(readClientSheetSyncConfig({ GOOGLE_CLIENT_SYNC_ENABLED: 'true' })).toEqual({ configured: false, reason: 'missing_configuration' });
  });
  it('normalizes explicit mapping keys only', () => {
    const result = readClientSheetSyncConfig(env);
    expect(result.configured && result.config.portfolios).toEqual({ TESTE: 'seller@example.invalid' });
  });
  it('exposes the same validated mapping independently of the Google connection', () => {
    expect(readClientPortfolioMappings(env)).toEqual({
      configured: true,
      portfolios: { TESTE: 'seller@example.invalid' },
    });
    expect(readClientPortfolioMappings({})).toEqual({
      configured: false,
      reason: 'missing_configuration',
    });
  });
  it.each(['{"Teste":"a@example.invalid"," TESTE ":"b@example.invalid"}',
    '{"TESTE":"a@example.invalid"," TESTE ":"b@example.invalid"}',
    '{"TESTE":"a@example.invalid","TESTE":"b@example.invalid"}',
    '{"TESTE":"a@example.invalid","\\u0054ESTE":"b@example.invalid"}',
    '{"ＴＥＳＴＥ":"a@example.invalid","TESTE":"b@example.invalid"}',
    '{"OUTROS":"a@example.invalid"}', '{"VERIFICAR":"a@example.invalid"}', '[]', 'invalid'])('fails closed for ambiguous or invalid config', (map) => {
    expect(readClientSheetSyncConfig({ ...env, GOOGLE_CLIENT_SYNC_PORTFOLIOS_JSON: map })).toEqual({ configured: false, reason: 'invalid_configuration' });
  });
  it('requires dedicated actor for an enabled schedule', () => {
    expect(readClientSheetSyncConfig({ ...env, GOOGLE_CLIENT_SYNC_SCHEDULE_ENABLED: 'true' }).configured).toBe(false);
  });
  it('canonicalizes the technical actor UUID', () => {
    const result = readClientSheetSyncConfig({ ...env, GOOGLE_CLIENT_SYNC_SCHEDULE_ENABLED: 'true',
      GOOGLE_CLIENT_SYNC_SCHEDULER_ACTOR_ID: 'ABCDEF00-0000-4000-8000-000000000001' });
    expect(result.configured && result.config.schedulerActorId).toBe('abcdef00-0000-4000-8000-000000000001');
  });
});
