import { z } from 'zod';
import { managementExecutionStatusSchema, managementServiceDateSchema } from './management-day';

const coordinateSchema = z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u);

export const managementMapQuerySchema = z.object({
  serviceDate: managementServiceDateSchema.optional(),
}).strict();

export const managementMapLocationSchema = z.object({
  latitude: coordinateSchema.refine((value) => Math.abs(Number(value)) <= 90),
  longitude: coordinateSchema.refine((value) => Math.abs(Number(value)) <= 180),
}).strict();

export const managementMapStopSchema = z.object({
  routeVersionStopId: z.uuid(),
  plannedOrder: z.number().int().positive().max(50),
  executionOrder: z.number().int().positive().max(50),
  priority: z.number().int().min(0).max(9),
  client: z.object({
    id: z.uuid(), name: z.string().trim().min(1).max(160), address: z.string().trim().min(1).max(300),
  }).strict(),
  status: managementExecutionStatusSchema,
  location: managementMapLocationSchema.nullable(),
}).strict();

export const managementMapRouteSchema = z.object({
  routeId: z.uuid(), routeVersionId: z.uuid(), versionNumber: z.number().int().positive(),
  seller: z.object({ id: z.uuid(), displayName: z.string().trim().min(1).max(120) }).strict(),
  stops: z.array(managementMapStopSchema).min(1).max(50),
}).strict();

export const managementMapResponseSchema = z.object({
  schemaVersion: z.literal(1),
  serviceDate: managementServiceDateSchema,
  generatedAt: z.iso.datetime({ offset: true }),
  availability: z.enum(['empty', 'available']),
  totals: z.object({
    routes: z.number().int().nonnegative(), stops: z.number().int().nonnegative(),
    positioned: z.number().int().nonnegative(), unpositioned: z.number().int().nonnegative(),
  }).strict(),
  routes: z.array(managementMapRouteSchema).max(500),
  serverVisibilityNote: z.literal(
    'O mapa usa coordenadas cadastrais do snapshot publicado; não exibe GPS observado nem representa trajeto por ruas.',
  ),
}).strict().superRefine((response, context) => {
  const stops = response.routes.flatMap((route) => route.stops);
  const positioned = stops.filter((stop) => stop.location !== null).length;
  if ((response.routes.length === 0) !== (response.availability === 'empty') ||
      response.totals.routes !== response.routes.length || response.totals.stops !== stops.length ||
      response.totals.positioned !== positioned || response.totals.unpositioned !== stops.length - positioned) {
    context.addIssue({ code: 'custom', path: ['totals'], message: 'Totais incompatíveis com as rotas do mapa.' });
  }
});

export type ManagementMapQuery = z.infer<typeof managementMapQuerySchema>;
export type ManagementMapLocation = z.infer<typeof managementMapLocationSchema>;
export type ManagementMapStop = z.infer<typeof managementMapStopSchema>;
export type ManagementMapRoute = z.infer<typeof managementMapRouteSchema>;
export type ManagementMapResponse = z.infer<typeof managementMapResponseSchema>;

export const managementMapPath = '/api/v1/management/map';
