import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, win32 } from 'node:path';

/**
 * Story 3.10 backup manifest v1 (UTF-8 JSON, beside the files it describes):
 * {
 *   "schemaVersion": 1,
 *   "databaseMigration": "20261006170000",
 *   "capturedAt": "2026-10-07T12:00:00.000Z",
 *   "database": { "path": "database.dump", "byteSize": 123, "sha256": "<64 lowercase hex>" },
 *   "scrapEvidence": {
 *     "bucket": "scrap-evidence",
 *     "expectedObjectCount": 1,
 *     "objects": [{
 *       "storagePath": "seller/<id>/collection/<id>/<id>.jpg",
 *       "path": "objects/seller/<id>/collection/<id>/<id>.jpg/<storage-version>",
 *       "byteSize": 456,
 *       "sha256": "<64 lowercase hex>"
 *     }]
 *   }
 * }
 *
 * All paths use forward slashes and are relative to the manifest's directory.
 * The object path must be `objects/${storagePath}` or that path followed by
 * one Storage version segment (the local Storage backend's physical layout).
 * The count proves only
 * that every declared object is present; matching the list to database rows
 * and a real restore are separate checks. This verifier never writes files.
 */

type FileEntry = { path: string; byteSize: number; sha256: string };
type ObjectEntry = FileEntry & { storagePath: string };
type BackupManifest = {
  schemaVersion: 1;
  databaseMigration: string;
  capturedAt: string;
  database: FileEntry;
  scrapEvidence: {
    bucket: 'scrap-evidence';
    expectedObjectCount: number;
    objects: ObjectEntry[];
  };
};

export type BackupVerification = {
  databaseBytes: number;
  expectedObjectCount: number;
  verifiedObjectCount: number;
  scrapEvidenceBytes: number;
};

const maxManifestBytes = 64 * 1024 * 1024;

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Formato do manifesto inválido.');
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new Error('Campos do manifesto inválidos.');
  }
}

function safeRelativePath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') ||
    isAbsolute(value) || win32.isAbsolute(value)) {
    throw new Error('Caminho relativo inválido.');
  }
  const segments = value.split('/');
  if (segments.some((part) => !part || part === '.' || part === '..' ||
    part.includes(':') || /[\x00-\x1f\x7f]/.test(part) || /[. ]$/.test(part) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error('Caminho relativo inválido.');
  }
  return value;
}

function fileEntry(value: unknown): FileEntry {
  const item = record(value);
  exactKeys(item, ['path', 'byteSize', 'sha256']);
  const path = safeRelativePath(item.path);
  if (!Number.isSafeInteger(item.byteSize) || (item.byteSize as number) <= 0 ||
    typeof item.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(item.sha256)) {
    throw new Error('Metadados do arquivo inválidos.');
  }
  return { path, byteSize: item.byteSize as number, sha256: item.sha256 };
}

function validMigrationVersion(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{14}$/.test(value)) return false;
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(8, 10)}:${value.slice(10, 12)}:${value.slice(12, 14)}.000Z`;
  return Number.isFinite(Date.parse(iso)) && new Date(iso).toISOString() === iso;
}

function parseManifest(value: unknown): BackupManifest {
  const manifest = record(value);
  exactKeys(manifest, ['schemaVersion', 'databaseMigration', 'capturedAt', 'database', 'scrapEvidence']);
  if (manifest.schemaVersion !== 1) throw new Error('Versão do manifesto não suportada.');
  if (!validMigrationVersion(manifest.databaseMigration) ||
    typeof manifest.capturedAt !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(manifest.capturedAt) ||
    !Number.isFinite(Date.parse(manifest.capturedAt)) ||
    new Date(manifest.capturedAt).toISOString() !== manifest.capturedAt) {
    throw new Error('Marco de captura ou migração inválido.');
  }
  const database = fileEntry(manifest.database);
  const evidence = record(manifest.scrapEvidence);
  exactKeys(evidence, ['bucket', 'expectedObjectCount', 'objects']);
  if (evidence.bucket !== 'scrap-evidence' || !Array.isArray(evidence.objects) ||
    !Number.isSafeInteger(evidence.expectedObjectCount) ||
    (evidence.expectedObjectCount as number) < 0 ||
    evidence.expectedObjectCount !== evidence.objects.length) {
    throw new Error('Cobertura dos objetos de sucata inválida.');
  }
  const paths = new Set<string>([database.path.toLowerCase()]);
  const storagePaths = new Set<string>();
  const objects = evidence.objects.map((value): ObjectEntry => {
    const item = record(value);
    exactKeys(item, ['storagePath', 'path', 'byteSize', 'sha256']);
    const entry = fileEntry({ path: item.path, byteSize: item.byteSize, sha256: item.sha256 });
    const storagePath = safeRelativePath(item.storagePath);
    const objectPrefix = `objects/${storagePath}`;
    const version = entry.path.startsWith(`${objectPrefix}/`)
      ? entry.path.slice(objectPrefix.length + 1) : null;
    if (entry.path !== objectPrefix && (version === null || !version || version.includes('/'))) {
      throw new Error('Mapeamento de objeto inválido.');
    }
    const normalizedPath = entry.path.toLowerCase();
    const normalizedStoragePath = storagePath.toLowerCase();
    if (paths.has(normalizedPath) || storagePaths.has(normalizedStoragePath)) {
      throw new Error('Arquivo ou objeto duplicado no manifesto.');
    }
    paths.add(normalizedPath);
    storagePaths.add(normalizedStoragePath);
    return { ...entry, storagePath };
  });
  return {
    schemaVersion: 1,
    databaseMigration: manifest.databaseMigration,
    capturedAt: manifest.capturedAt,
    database,
    scrapEvidence: {
      bucket: 'scrap-evidence',
      expectedObjectCount: evidence.expectedObjectCount as number,
      objects,
    },
  };
}

async function assertNoSymlink(absolutePath: string) {
  const absolute = resolve(absolutePath);
  const root = parse(absolute).root;
  const segments = relative(root, absolute).split(/[\\/]/).filter(Boolean);
  let current = root;
  try {
    for (const segment of segments) {
      current = join(current, segment);
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error('Link simbólico não permitido.');
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'Link simbólico não permitido.') throw error;
    throw new Error('Arquivo ausente ou inacessível.');
  }
}

async function verifyFile(directory: string, entry: FileEntry): Promise<number> {
  const absolute = join(directory, ...entry.path.split('/'));
  await assertNoSymlink(absolute);
  let handle;
  try {
    handle = await open(absolute, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
    const before = await handle.stat();
    if (!before.isFile() || before.size !== entry.byteSize) throw new Error('Tamanho ou tipo de arquivo divergente.');
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    const after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
      hash.digest('hex') !== entry.sha256) {
      throw new Error('SHA-256 ou integridade do arquivo divergente.');
    }
  } catch (error) {
    if (error instanceof Error && /^(Tamanho|SHA-256|Link simbólico)/.test(error.message)) throw error;
    throw new Error('Arquivo ausente ou inacessível.');
  } finally {
    await handle?.close();
  }
  await assertNoSymlink(absolute);
  const base = await realpath(directory);
  const target = await realpath(absolute);
  const within = relative(base, target);
  if (!within || within === '..' || within.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(within)) {
    throw new Error('Arquivo fora do diretório do manifesto.');
  }
  return entry.byteSize;
}

export async function verifyBackupManifest(manifestPath: string): Promise<BackupVerification> {
  if (typeof manifestPath !== 'string' || !manifestPath.trim()) {
    throw new Error('Informe --manifest com um arquivo JSON.');
  }
  const absolute = resolve(manifestPath);
  await assertNoSymlink(absolute);
  let raw: string;
  try {
    const info = await lstat(absolute);
    if (!info.isFile() || info.size > maxManifestBytes) throw new Error('Arquivo de manifesto inválido.');
    raw = await readFile(absolute, 'utf8');
  } catch {
    throw new Error('Arquivo de manifesto ausente ou inválido.');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('JSON do manifesto inválido.'); }
  const manifest = parseManifest(parsed);
  const directory = dirname(absolute);
  const databaseBytes = await verifyFile(directory, manifest.database);
  let scrapEvidenceBytes = 0;
  for (const item of manifest.scrapEvidence.objects) {
    scrapEvidenceBytes += await verifyFile(directory, item);
    if (!Number.isSafeInteger(scrapEvidenceBytes)) throw new Error('Total de bytes inválido.');
  }
  return {
    databaseBytes,
    expectedObjectCount: manifest.scrapEvidence.expectedObjectCount,
    verifiedObjectCount: manifest.scrapEvidence.objects.length,
    scrapEvidenceBytes,
  };
}
