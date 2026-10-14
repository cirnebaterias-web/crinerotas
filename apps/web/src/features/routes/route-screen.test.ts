import { describe, expect, it } from 'vitest';
import { checkinFailureMessage } from './checkin-failure-message';

describe('checkinFailureMessage', () => {
  it('does not claim an already persisted visit is unchanged when evidence fails', () => {
    expect(checkinFailureMessage(true)).toContain('A visita foi iniciada');
    expect(checkinFailureMessage(true)).toContain('não foi possível salvar a evidência de check-in');
  });

  it('keeps the original message when visit start itself fails', () => {
    expect(checkinFailureMessage(false)).toContain('A parada continua inalterada');
  });
});
