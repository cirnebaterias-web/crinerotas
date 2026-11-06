import type { LogisticsPickupRecord } from '@cirne/contracts';

export function pickupOutcomeLabel(record: LogisticsPickupRecord) {
  if (!record.result) return record.assignment ? 'Aguardando coleta' : 'Aguardando atribuição';
  if (record.result.outcome === 'not_collected') return 'Não coletado';
  if (!/[1-9]/u.test(record.result.differenceKg)) return 'Coleta cumprida';
  return record.result.differenceKg.startsWith('-') ? 'Coleta parcial' : 'Acima da promessa';
}

export function formatPickupDocument(value: string | null) {
  if (!value) return 'CNPJ/CPF não informado';
  if (value.length === 14) return `CNPJ: ${value.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/u, '$1.$2.$3/$4-$5')}`;
  return `CPF: ${value.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/u, '$1.$2.$3-$4')}`;
}

export function decimalKg(value: string) { return value.replace('.', ','); }

export function equalWeight(left: string, right: string) {
  const canonical = (value: string) => value.replace(/(\.\d*?)0+$/u, '$1').replace(/\.$/u, '');
  return canonical(left) === canonical(right);
}
