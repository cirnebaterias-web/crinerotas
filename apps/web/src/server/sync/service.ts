import {
  recoverableSyncErrorCodeSchema,
  rejectedSyncErrorCodeSchema,
  syncBatchRequestSchema,
  syncBatchResponseSchema,
  type SyncBatchRequest,
  type SyncCommand,
  type SyncErrorCode,
  type SyncResult,
} from '@cirne/contracts';

type ConfirmedSyncResult = Extract<SyncResult, { status: 'confirmed' }>;

export interface SyncEventRepository {
  synchronize(deviceId: string, command: SyncCommand): Promise<ConfirmedSyncResult>;
}

export class SyncEventFailure extends Error {
  constructor(
    public readonly code: SyncErrorCode,
    message: string,
    public readonly recoverable: boolean,
  ) {
    super(message);
  }
}

const publicMessages: Record<SyncErrorCode, string> = {
  AUTH_REQUIRED: 'Autenticação necessária.',
  FORBIDDEN: 'Operação não autorizada.',
  VALIDATION_FAILED: 'Evento de sincronização inválido.',
  VERSION_CONFLICT: 'A versão enviada conflita com o servidor.',
  EVENT_OUT_OF_ORDER: 'Evento aguardando a confirmação de uma dependência anterior.',
  IDEMPOTENCY_KEY_REUSED: 'A chave de idempotência já foi usada com outro conteúdo.',
  RATE_LIMITED: 'Limite temporário de sincronização atingido.',
  DEPENDENCY_UNAVAILABLE: 'Serviço de sincronização temporariamente indisponível.',
  INTERNAL_ERROR: 'Não foi possível sincronizar o evento agora.',
};

export function publicSyncMessage(code: SyncErrorCode) {
  return publicMessages[code];
}

function failedResult(eventId: string, failure: SyncEventFailure): SyncResult {
  const recoverableCode = recoverableSyncErrorCodeSchema.safeParse(failure.code);
  if (failure.recoverable && recoverableCode.success) {
    return {
      eventId,
      status: 'recoverable_error',
      error: { code: recoverableCode.data, message: publicSyncMessage(recoverableCode.data), recoverable: true },
    };
  }
  const rejectedCode = rejectedSyncErrorCodeSchema.safeParse(failure.code);
  if (!failure.recoverable && rejectedCode.success) {
    return {
      eventId,
      status: 'rejected',
      error: { code: rejectedCode.data, message: publicSyncMessage(rejectedCode.data), recoverable: false },
    };
  }
  return {
    eventId,
    status: 'recoverable_error',
    error: { code: 'INTERNAL_ERROR', message: publicSyncMessage('INTERNAL_ERROR'), recoverable: true },
  };
}

export async function processSyncBatch(
  input: SyncBatchRequest,
  requestId: string,
  repository: SyncEventRepository,
) {
  const batch = syncBatchRequestSchema.parse(input);
  const blockedAggregates = new Set<string>();
  const results: SyncResult[] = [];

  for (const command of batch.events) {
    const aggregateKey = `${command.aggregateType}:${command.aggregateId}`;
    if (blockedAggregates.has(aggregateKey)) {
      results.push(failedResult(command.eventId, new SyncEventFailure(
        'EVENT_OUT_OF_ORDER',
        publicSyncMessage('EVENT_OUT_OF_ORDER'),
        false,
      )));
      continue;
    }

    try {
      results.push(await repository.synchronize(batch.deviceId, command));
    } catch (error) {
      const failure = error instanceof SyncEventFailure
        ? error
        : new SyncEventFailure('INTERNAL_ERROR', publicSyncMessage('INTERNAL_ERROR'), true);
      results.push(failedResult(command.eventId, failure));
      blockedAggregates.add(aggregateKey);
    }
  }

  return syncBatchResponseSchema.parse({ requestId, results });
}
