export class SyncEventPersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncEventPersistenceError';
  }
}
