import { describe, expect, it } from 'vitest';
import { managerHomeOperations } from './manager-home-operations';

describe('manager home operations', () => {
  it('prioritizes the command center and daily route creation for an authorized manager', () => {
    const operations = managerHomeOperations({
      roles: ['manager'],
      capabilities: ['route.read_scoped', 'route.plan_scoped'],
    });
    expect(operations.map((operation) => operation.title)).toEqual([
      'Central do gestor', 'Criar rota do dia', 'Métricas do piloto',
    ]);
    expect(operations[1]?.href).toBe('/management/routes');
  });

  it('does not expose manager entries to another role', () => {
    expect(managerHomeOperations({
      roles: ['seller'],
      capabilities: ['route.read_scoped', 'route.plan_scoped'],
    })).toEqual([]);
  });
});
