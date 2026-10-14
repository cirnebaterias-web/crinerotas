import {
  apiErrorResponseSchema,
  createPickupScheduleRequestSchema,
  mePath,
  meResponseSchema,
  pickupScheduleSchema,
  scrapClientListSchema,
  scrapClientsPath,
  scrapSchedulesPath,
  type PickupScheduleInput,
  type ScrapClient,
  type OfflinePartition,
} from '@cirne/contracts';
import { createValidatedLocalSession, evaluateLocalAccess } from '@cirne/domain';
import { OfflineDatabase, type LocalScrapClient, type LocalStandaloneScrapSchedule } from './database';

const deviceKey = 'cirne-rotas.device-id';
const userKey = 'cirne-rotas.last-user-id';
const scrapCsrfToken = 'cirne-route-v1';

export class StandaloneScrapScheduleStore {
  private readonly db: OfflineDatabase;
  private syncing: Promise<LocalStandaloneScrapSchedule[]> | null = null;

  constructor(database = new OfflineDatabase(), private readonly now = () => new Date().toISOString()) {
    this.db = database;
  }

  close() { this.db.close(); }

  private deviceId() {
    let id = window.localStorage.getItem(deviceKey);
    if (!id) { id = crypto.randomUUID(); window.localStorage.setItem(deviceKey, id); }
    return id;
  }

  private async partition(): Promise<OfflinePartition> {
    await this.db.open();
    const deviceId = this.deviceId();
    if (navigator.onLine) {
      let response: Response | undefined;
      try {
        response = await fetch(mePath, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15_000) });
      } catch { /* Use the locally validated window if the network is temporarily unavailable. */ }
      if (response?.ok) {
        const identity = meResponseSchema.parse(await response.json());
        if (!identity.roles.includes('seller') || identity.status !== 'active') {
          throw new Error('Acesso de vendedor ativo necessário para agendar.');
        }
        const partition = { userId: identity.id, deviceId };
        await this.db.localSessions.put(createValidatedLocalSession(partition, this.now()));
        window.localStorage.setItem(userKey, identity.id);
        return partition;
      }
      if (response?.status === 401 || response?.status === 403) throw new Error('Entre novamente para agendar.');
    }
    const userId = window.localStorage.getItem(userKey);
    if (!userId) throw new Error('Entre online ao menos uma vez para agendar offline.');
    const partition = { userId, deviceId };
    const session = await this.db.localSessions.get([userId, deviceId]);
    if (!session || !evaluateLocalAccess(session, partition, this.now()).allowed) {
      throw new Error('A sessão offline expirou. Entre novamente quando houver conexão.');
    }
    return partition;
  }

  async searchClients(query: string): Promise<ScrapClient[]> {
    const partition = await this.partition();
    const normalized = query.trim().toLocaleLowerCase('pt-BR');
    if (navigator.onLine) {
      try {
        const response = await fetch(`${scrapClientsPath}?q=${encodeURIComponent(query.trim())}`, {
          credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new Error('Falha ao buscar clientes.');
        const clients = scrapClientListSchema.parse(await response.json()).clients;
        await this.db.scrapClients.bulkPut(clients.map((client): LocalScrapClient => ({
          ...partition, ...client, cachedAt: this.now(),
        })));
        return clients;
      } catch { /* A consulta local usa somente clientes previamente autorizados e vistos. */ }
    }
    return (await this.db.scrapClients.where('[userId+deviceId]').equals([
      partition.userId, partition.deviceId,
    ]).toArray()).filter((client) => `${client.name} ${client.address}`.toLocaleLowerCase('pt-BR')
      .includes(normalized)).slice(0, 30).map(({ id, name, address }) => ({ id, name, address }));
  }

  async listSchedules(): Promise<LocalStandaloneScrapSchedule[]> {
    const partition = await this.partition();
    const schedules = await this.db.scrapSchedules.where('[userId+deviceId]').equals([
      partition.userId, partition.deviceId,
    ]).toArray();
    return schedules.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async enqueue(client: ScrapClient, input: PickupScheduleInput) {
    const partition = await this.partition();
    const request = createPickupScheduleRequestSchema.parse({ schemaVersion: 1, clientId: client.id, ...input });
    const key: [string, string, string] = [partition.userId, partition.deviceId, input.offlineId];
    return this.db.transaction('rw', this.db.scrapSchedules, async () => {
      const previous = await this.db.scrapSchedules.get(key);
      if (previous) {
        if (JSON.stringify(previous.request) !== JSON.stringify(request)) {
          throw new Error('Este agendamento já foi salvo com outros dados; crie um novo.');
        }
        return previous;
      }
      const record: LocalStandaloneScrapSchedule = {
        ...partition, offlineId: input.offlineId, client, request,
        idempotencyKey: crypto.randomUUID(), status: 'pending', createdAt: this.now(),
      };
      await this.db.scrapSchedules.add(record);
      return record;
    });
  }

  synchronize(): Promise<LocalStandaloneScrapSchedule[]> {
    if (this.syncing) return this.syncing;
    const operation = this.sendPending().finally(() => { if (this.syncing === operation) this.syncing = null; });
    this.syncing = operation;
    return operation;
  }

  private async sendPending() {
    if (!navigator.onLine) return this.listSchedules();
    const partition = await this.partition();
    const records = await this.db.scrapSchedules.where('[userId+deviceId]').equals([
      partition.userId, partition.deviceId,
    ]).filter((record) => record.status === 'pending').sortBy('createdAt');
    for (const record of records) {
      let response: Response;
      try {
        response = await fetch(scrapSchedulesPath, {
          method: 'POST', credentials: 'same-origin', cache: 'no-store',
          headers: {
            'Content-Type': 'application/json', 'X-CSRF-Token': scrapCsrfToken,
            'X-Device-Id': partition.deviceId, 'Idempotency-Key': record.idempotencyKey,
          },
          body: JSON.stringify(record.request), signal: AbortSignal.timeout(30_000),
        });
      } catch { break; }
      if (response.ok) {
        const saved = pickupScheduleSchema.parse(await response.json());
        if (saved.offlineId !== record.offlineId) throw new Error('Resposta de agendamento incompatível.');
        await this.db.scrapSchedules.put({ ...record, status: 'synced', serverId: saved.id,
          serverSavedAt: saved.serverSavedAt, lastError: undefined });
        continue;
      }
      let message = 'Falha temporária no envio. O agendamento permanece no aparelho.';
      try {
        const parsed = apiErrorResponseSchema.safeParse(await response.json());
        if (parsed.success) message = parsed.data.error.message;
      } catch { /* Keep the safe message. */ }
      if (response.status >= 400 && response.status < 500 && response.status !== 401 && response.status !== 429) {
        await this.db.scrapSchedules.put({ ...record, status: 'action_required', lastError: message });
        continue;
      }
      break;
    }
    return this.listSchedules();
  }
}
