import { describe, expect, it } from 'vitest';
import { managementClientsCsv } from './client-export';

describe('management client export', () => {
  it('exports classification and operational status separately from legacy registration status', () => {
    const csv = managementClientsCsv([{ schemaVersion: 1, id: '10000000-0000-4000-8000-000000000001', externalReference: 'C-1',
      name: '=Cliente', status: 'active', operatingStatus: 'closed', classificationCode: 'autopecas',
      classificationLabel: 'AUTOPECAS', operatingClosedReason: 'Encerrou atividades', address: 'Rua A', sellerEmail: null,
      sellerId: null, portfolioReference: null, googleLocation: null, latitude: null, longitude: null, version: 1 }]);
    expect(csv).toContain('"Cadastro","Status operacional","Classificação"');
    expect(csv).toContain('"Ativo","Encerrado","AUTOPECAS","Encerrou atividades"');
    expect(csv).toContain("\"'=Cliente\"");
  });
});
