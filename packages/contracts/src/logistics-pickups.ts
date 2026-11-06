import { z } from 'zod';

// Weights remain decimal strings all the way to PostgreSQL numeric.
const weight = z.string().max(200).regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/u);
const positiveWeight = weight.refine((value) => /[1-9]/u.test(value));
const signedWeight = z.string().max(201).regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u);
const actor = z.object({ id: z.uuid(), displayName: z.string().min(1).max(120) }).strict();
const reason = z.string().trim().min(1).max(1000);
const instant = z.iso.datetime({ offset: true });
const commandBase = { schemaVersion: z.literal(1), expectedVersion: z.number().int().positive() };

export const assignLogisticsPickupSchema = z.object({
  ...commandBase, operatorId: z.uuid(), routeDate: z.iso.date(),
  routeOrder: z.number().int().min(1).max(10000), reason,
}).strict();
export const recordLogisticsPickupSchema = z.object({
  ...commandBase, outcome: z.enum(['collected', 'not_collected']),
  actualWeightKg: weight, reason: reason.optional(),
}).strict().superRefine((value, context) => {
  const positive = /[1-9]/u.test(value.actualWeightKg);
  if ((value.outcome === 'collected') !== positive) {
    context.addIssue({ code: 'custom', path: ['actualWeightKg'], message: 'Informe peso positivo para coleta ou zero para não coletado.' });
  }
  if (value.outcome === 'not_collected' && !value.reason) {
    context.addIssue({ code: 'custom', path: ['reason'], message: 'Explique por que a coleta não aconteceu.' });
  }
});
export const correctLogisticsPickupSchema = z.object({
  ...commandBase, outcome: z.enum(['collected', 'not_collected']), actualWeightKg: weight, reason,
}).strict().superRefine((value, context) => {
  if ((value.outcome === 'collected') !== /[1-9]/u.test(value.actualWeightKg)) {
    context.addIssue({ code: 'custom', path: ['actualWeightKg'], message: 'Peso incompatível com o resultado informado.' });
  }
});
export const reviewLogisticsPickupSchema = z.object({ ...commandBase, reason }).strict();
export const logisticsPickupAssignmentSchema = z.object({
  operator: actor, routeDate: z.iso.date(), routeOrder: z.number().int().positive(), assignedAt: instant,
}).strict();
export const logisticsPickupResultSchema = z.object({
  outcome: z.enum(['collected', 'not_collected']), actualWeightKg: weight,
  differenceKg: signedWeight, reason: z.string().nullable(), recordedBy: actor, recordedAt: instant,
}).strict();
export const logisticsPickupReviewSchema = z.object({
  reason, reviewedBy: actor, reviewedAt: instant,
}).strict();
const historySnapshot = z.object({
  promisedWeightKg: positiveWeight.optional(), desiredDate: z.iso.date().optional(),
  period: z.enum(['morning', 'afternoon']).optional(), observation: z.string().nullable().optional(),
  assignment: logisticsPickupAssignmentSchema.nullable().optional(),
  result: logisticsPickupResultSchema.nullable().optional(),
  review: logisticsPickupReviewSchema.nullable().optional(),
}).strict();
export const logisticsPickupRecordSchema = z.object({
  scheduleId: z.uuid(), version: z.number().int().positive(),
  client: z.object({ id: z.uuid(), name: z.string(), document: z.string().regex(/^(?:\d{11}|\d{14})$/u).nullable(), address: z.string() }).strict(),
  seller: actor, promisedWeightKg: positiveWeight, desiredDate: z.iso.date(),
  period: z.enum(['morning', 'afternoon']), observation: z.string().nullable(),
  assignment: logisticsPickupAssignmentSchema.nullable(), result: logisticsPickupResultSchema.nullable(),
  resultOriginal: logisticsPickupResultSchema.nullable(), review: logisticsPickupReviewSchema.nullable(),
  reviewRequired: z.boolean(),
  history: z.array(z.object({
    action: z.enum(['schedule_created', 'schedule_revised', 'assigned', 'result_recorded', 'result_corrected', 'reviewed']),
    actor, occurredAt: instant, reason: z.string().nullable(), before: historySnapshot.nullable(), after: historySnapshot,
  }).strict()),
}).strict();
export const logisticsPickupListSchema = z.object({
  schemaVersion: z.literal(1), date: z.iso.date(), generatedAt: instant,
  records: z.array(logisticsPickupRecordSchema),
  totals: z.object({
    promisedWeightKg: weight, collectedWeightKg: weight, differenceKg: signedWeight,
    pending: z.number().int().nonnegative(), reviewRequired: z.number().int().nonnegative(),
  }).strict(),
}).strict();
export const logisticsOperatorListSchema = z.object({ schemaVersion: z.literal(1), operators: z.array(actor) }).strict();
export const logisticsPickupDateSchema = z.iso.date();
export const logisticsPickupsPath = '/api/v1/logistics/pickups';
export const logisticsOperatorsPath = '/api/v1/logistics/operators';
export type LogisticsPickupRecord = z.infer<typeof logisticsPickupRecordSchema>;
export type LogisticsPickupList = z.infer<typeof logisticsPickupListSchema>;
export type LogisticsOperatorList = z.infer<typeof logisticsOperatorListSchema>;
export type AssignLogisticsPickup = z.infer<typeof assignLogisticsPickupSchema>;
export type RecordLogisticsPickup = z.infer<typeof recordLogisticsPickupSchema>;
export type CorrectLogisticsPickup = z.infer<typeof correctLogisticsPickupSchema>;
export type ReviewLogisticsPickup = z.infer<typeof reviewLogisticsPickupSchema>;
export type LogisticsPickupAction = 'assignment' | 'result' | 'correction' | 'review';
