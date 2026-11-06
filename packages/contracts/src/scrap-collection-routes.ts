import { z } from 'zod';

const weight = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/u);
const coordinate = z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }).strict();

export const scrapCollectionRoutePolicySchema = z.object({
  version: z.literal('scrap-route-proximity-v1'),
  method: z.literal('centroid-edge-nearest-neighbor'),
  distance: z.literal('haversine_approximation'),
}).strict();

export const scrapCollectionRouteCandidateSchema = z.object({
  scheduleId: z.uuid(), clientName: z.string().trim().min(1).max(160),
  address: z.string().trim().min(1).max(300), promisedWeightKg: weight,
  location: coordinate.nullable(),
}).strict();

export const scrapCollectionRouteStopSchema = scrapCollectionRouteCandidateSchema.extend({
  suggestedOrder: z.number().int().positive(),
  approximateFromPreviousKm: z.number().finite().nonnegative().nullable(),
  geographyStatus: z.enum(['calculated', 'pending_location']),
  result: z.enum(['collected', 'not_collected']).nullable(),
}).strict();

export const scrapCollectionRouteSchema = z.object({
  schemaVersion: z.literal(1), routeId: z.uuid(), version: z.number().int().positive(),
  routeDate: z.iso.date(), status: z.enum(['draft', 'approved', 'assigned', 'in_progress', 'completed', 'cancelled']),
  operatorId: z.uuid().nullable(), generatedAt: z.iso.datetime({ offset: true }),
  policy: scrapCollectionRoutePolicySchema, stops: z.array(scrapCollectionRouteStopSchema).min(1).max(500),
  counts: z.object({ total: z.number().int().positive(), geocoded: z.number().int().nonnegative(),
    pendingLocation: z.number().int().nonnegative(), completed: z.number().int().nonnegative() }).strict(),
}).strict();
export const scrapCollectionRouteListSchema = z.object({
  schemaVersion: z.literal(1), date: z.iso.date(), generatedAt: z.iso.datetime({ offset: true }),
  routes: z.array(scrapCollectionRouteSchema),
}).strict();

const expectedVersion = z.number().int().positive();
const scheduleIds = z.array(z.uuid()).min(1).max(500).refine(
  (items) => new Set(items).size === items.length,
  'Um agendamento não pode aparecer duas vezes na rota.',
);

export const createScrapCollectionRouteSchema = z.object({
  schemaVersion: z.literal(1), routeDate: z.iso.date(), scheduleIds,
}).strict();

export const reorderScrapCollectionRouteSchema = z.object({
  schemaVersion: z.literal(1), expectedVersion,
  stops: z.array(z.object({ scheduleId: z.uuid(), plannedOrder: z.number().int().positive().max(500) }).strict())
    .min(1).max(500)
    .refine((items) => new Set(items.map(({ scheduleId }) => scheduleId)).size === items.length,
      'Um agendamento não pode aparecer duas vezes na rota.')
    .refine((items) => new Set(items.map(({ plannedOrder }) => plannedOrder)).size === items.length,
      'A ordem das paradas não pode se repetir.'),
  reason: z.string().trim().min(1).max(500),
}).strict();

export const reviseScrapCollectionRouteSchema = z.object({
  schemaVersion: z.literal(1), expectedVersion, scheduleIds,
  reason: z.string().trim().min(1).max(500),
}).strict();

export const approveScrapCollectionRouteSchema = z.object({
  schemaVersion: z.literal(1), expectedVersion, reason: z.string().trim().min(1).max(500),
}).strict();

export const assignScrapCollectionRouteSchema = z.object({
  schemaVersion: z.literal(1), expectedVersion, operatorId: z.uuid(), reason: z.string().trim().min(1).max(500),
}).strict();

export const scrapCollectionRoutesPath = '/api/v1/logistics/routes';
export const scrapCollectionRoutePath = (routeId: string) => `${scrapCollectionRoutesPath}/${routeId}`;
export const scrapCollectionRouteOperationPath = (routeId: string, operation: 'revise' | 'reorder' | 'approve' | 'assign') =>
  `${scrapCollectionRoutePath(routeId)}/${operation}`;

export type ScrapCollectionRouteCandidate = z.infer<typeof scrapCollectionRouteCandidateSchema>;
export type ScrapCollectionRoute = z.infer<typeof scrapCollectionRouteSchema>;
export type CreateScrapCollectionRoute = z.infer<typeof createScrapCollectionRouteSchema>;
export type ReorderScrapCollectionRoute = z.infer<typeof reorderScrapCollectionRouteSchema>;
export type ReviseScrapCollectionRoute = z.infer<typeof reviseScrapCollectionRouteSchema>;
export type ApproveScrapCollectionRoute = z.infer<typeof approveScrapCollectionRouteSchema>;
export type AssignScrapCollectionRoute = z.infer<typeof assignScrapCollectionRouteSchema>;
