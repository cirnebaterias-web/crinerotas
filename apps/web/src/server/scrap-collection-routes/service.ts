import { z } from 'zod';
import {
  approveScrapCollectionRouteSchema, assignScrapCollectionRouteSchema,
  createScrapCollectionRouteSchema, reorderScrapCollectionRouteSchema,
  reviseScrapCollectionRouteSchema,
  scrapCollectionRouteListSchema, scrapCollectionRouteSchema,
  type MeResponse,
} from '@cirne/contracts';
import { RouteRequestError } from '../routes/http';

export type ScrapCollectionRouteOperation = 'revise' | 'reorder' | 'approve' | 'assign';

export interface ScrapCollectionRouteRepository {
  list(date: string): Promise<unknown>;
  get(routeId: string): Promise<unknown>;
  create(idempotencyKey: string, command: unknown): Promise<unknown>;
  change(routeId: string, operation: ScrapCollectionRouteOperation,
    idempotencyKey: string, command: unknown): Promise<unknown>;
}

export function requireScrapCollectionRouteManager(identity: MeResponse) {
  const allowed = identity.status === 'active' && identity.capabilities.includes('scrap.dispatch_pickups') &&
    (identity.roles.includes('administrator') ||
      (identity.roles.includes('manager') && identity.scopeIds.length > 0));
  if (!allowed) throw new RouteRequestError(403, 'FORBIDDEN', 'Planejamento de rotas não autorizado.', false);
}

export function requireScrapCollectionRouteRead(identity: MeResponse) {
  const operator = identity.status === 'active' && identity.roles.includes('logistics') &&
    identity.capabilities.includes('scrap.execute_pickups');
  if (!operator) requireScrapCollectionRouteManager(identity);
}

function validate<T>(schema: { safeParse(input: unknown): { success: true; data: T } | { success: false } },
  input: unknown, response = false): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new RouteRequestError(response ? 503 : 422,
    response ? 'DEPENDENCY_UNAVAILABLE' : 'VALIDATION_FAILED',
    response ? 'Rotas de coleta temporariamente indisponíveis.' : 'Revise os dados da rota de coleta.', response);
  return parsed.data;
}

export async function listScrapCollectionRoutes(identity: MeResponse, date: unknown,
  repository: ScrapCollectionRouteRepository) {
  requireScrapCollectionRouteRead(identity);
  const parsedDate = validate(z.iso.date(), date);
  return validate(scrapCollectionRouteListSchema, await repository.list(parsedDate), true);
}

export async function getScrapCollectionRoute(identity: MeResponse, routeId: unknown,
  repository: ScrapCollectionRouteRepository) {
  requireScrapCollectionRouteRead(identity);
  return validate(scrapCollectionRouteSchema, await repository.get(validate(z.uuid(), routeId)), true);
}

export async function createScrapCollectionRoute(identity: MeResponse, idempotencyKey: unknown, body: unknown,
  repository: ScrapCollectionRouteRepository) {
  requireScrapCollectionRouteManager(identity);
  const key = validate(z.uuid(), idempotencyKey);
  const command = validate(createScrapCollectionRouteSchema, body);
  return validate(scrapCollectionRouteSchema, await repository.create(key, command), true);
}

export async function changeScrapCollectionRoute(identity: MeResponse, routeId: unknown, operation: unknown,
  idempotencyKey: unknown, body: unknown, repository: ScrapCollectionRouteRepository) {
  requireScrapCollectionRouteManager(identity);
  const id = validate(z.uuid(), routeId);
  const action = validate(z.enum(['revise', 'reorder', 'approve', 'assign']), operation);
  const key = validate(z.uuid(), idempotencyKey);
  const command = action === 'revise' ? validate(reviseScrapCollectionRouteSchema, body)
    : action === 'reorder' ? validate(reorderScrapCollectionRouteSchema, body)
    : action === 'approve' ? validate(approveScrapCollectionRouteSchema, body)
      : validate(assignScrapCollectionRouteSchema, body);
  return validate(scrapCollectionRouteSchema, await repository.change(id, action, key, command), true);
}
