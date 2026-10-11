export const checkinFailureMessage = (visitStarted: boolean) => visitStarted
  ? 'A visita foi iniciada, mas não foi possível salvar a evidência de check-in. Tente concluir o check-in novamente.'
  : 'Não foi possível salvar o início da visita neste aparelho. A parada continua inalterada.';
