import type { MeResponse } from '@cirne/contracts';
import { RouteRequestError } from '../routes/http';
export { handleClientImportRequest as handleClientSalesRequest } from '../client-imports/http';
export function requireSalesRead(identity: MeResponse, planning = false) {
  if (!identity.capabilities.includes('sales.read_client')
      || (planning && !identity.capabilities.includes('route.plan_scoped'))) {
    throw new RouteRequestError(403, 'FORBIDDEN', 'Consulta não autorizada.', false);
  }
}
