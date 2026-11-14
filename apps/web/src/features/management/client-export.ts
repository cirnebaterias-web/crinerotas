import type { ImportedClient } from '@cirne/contracts';

const csvCell = (value: unknown) => {
  const raw = String(value ?? '');
  const safe = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
};

export function managementClientsCsv(clients: ImportedClient[]) {
  const headers = ['Referência', 'Cliente', 'Cadastro', 'Status operacional', 'Classificação', 'Motivo do encerramento', 'Endereço', 'Vendedor'];
  const rows = clients.map((client) => [client.externalReference, client.name,
    client.status === 'active' ? 'Ativo' : 'Arquivado', client.operatingStatus === 'closed' ? 'Encerrado' : 'Em atividade',
    client.classificationLabel ?? 'Não classificado', client.operatingClosedReason ?? '', client.address, client.sellerEmail ?? 'Sem carteira']);
  return `\uFEFF${[headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}
