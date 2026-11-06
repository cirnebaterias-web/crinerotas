import { expect, it } from 'vitest';
import { logisticsPickupRecordSchema } from '@cirne/contracts';
import { equalWeight, formatPickupDocument, pickupOutcomeLabel } from './pickup-labels';

const actor = { id: '11111111-1111-4111-8111-111111111111', displayName: 'Operador teste' };
const time = '2026-11-04T12:00:00Z';
const base = {
  scheduleId: '22222222-2222-4222-8222-222222222222', version: 1,
  client: { id: '33333333-3333-4333-8333-333333333333', name: 'Cliente teste', document: null, address: 'Rua de teste' },
  seller: actor, promisedWeightKg: '100', desiredDate: '2026-11-04', period: 'morning', observation: null,
  assignment: { operator: actor, routeDate: '2026-11-04', routeOrder: 1, assignedAt: time },
  result: null, resultOriginal: null, review: null, reviewRequired: false, history: [],
};
it('does not confuse pending, no collection, partial or excess with a fulfilled promise', () => {
  expect(pickupOutcomeLabel(logisticsPickupRecordSchema.parse(base))).toBe('Aguardando coleta');
  for (const [weight, difference, outcome, label] of [
    ['100.00', '0.00', 'collected', 'Coleta cumprida'], ['80', '-20', 'collected', 'Coleta parcial'],
    ['120', '20', 'collected', 'Acima da promessa'], ['0', '-100', 'not_collected', 'Não coletado'],
  ]) {
    const record = logisticsPickupRecordSchema.parse({ ...base, result: { outcome, actualWeightKg: weight,
      differenceKg: difference, reason: 'Conferência', recordedBy: actor, recordedAt: time } });
    expect(pickupOutcomeLabel(record)).toBe(label);
  }
});
it('compares decimal weights exactly and labels missing or individual documents honestly', () => {
  expect(equalWeight('100.000', '100')).toBe(true);
  expect(equalWeight('100.00000000000000001', '100')).toBe(false);
  expect(formatPickupDocument(null)).toBe('CNPJ/CPF não informado');
  expect(formatPickupDocument('12345678901')).toMatch(/^CPF:/u);
  expect(formatPickupDocument('12345678000199')).toBe('CNPJ: 12.345.678/0001-99');
});
