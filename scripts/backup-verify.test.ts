import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyBackupManifest } from './backup-verify';

const temporaryDirectories: string[] = [];

function digest(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'cirne-backup-verify-'));
  temporaryDirectories.push(directory);
  const storagePath = 'seller/synthetic/collection/synthetic/term.jpg';
  const objectPath = `objects/${storagePath}`;
  const database = Buffer.from('synthetic database backup');
  const evidence = Buffer.from('synthetic private evidence');
  await mkdir(join(directory, 'objects', 'seller', 'synthetic', 'collection', 'synthetic'), { recursive: true });
  await writeFile(join(directory, 'database.dump'), database);
  await writeFile(join(directory, ...objectPath.split('/')), evidence);
  const manifest = {
    schemaVersion: 1,
    databaseMigration: '20261006170000',
    capturedAt: '2026-10-07T12:00:00.000Z',
    database: { path: 'database.dump', byteSize: database.length, sha256: digest(database) },
    scrapEvidence: {
      bucket: 'scrap-evidence',
      expectedObjectCount: 1,
      objects: [{ storagePath, path: objectPath, byteSize: evidence.length, sha256: digest(evidence) }],
    },
  };
  const manifestPath = join(directory, 'manifest.json');
  const save = async () => writeFile(manifestPath, JSON.stringify(manifest));
  await save();
  return { directory, manifest, manifestPath, save };
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    if (!directory.startsWith(join(tmpdir(), 'cirne-backup-verify-'))) throw new Error('Unsafe test cleanup');
    await rm(directory, { recursive: true, force: true });
  }
});

describe('ops:backup:verify', () => {
  it('checks the database and every declared private object without exposing paths', async () => {
    const { manifestPath } = await fixture();
    expect(await verifyBackupManifest(manifestPath)).toEqual({
      databaseBytes: 25,
      expectedObjectCount: 1,
      verifiedObjectCount: 1,
      scrapEvidenceBytes: 26,
    });
  });

  it('accepts the local Storage backend version suffix for an object', async () => {
    const { directory, manifest, manifestPath, save } = await fixture();
    const object = manifest.scrapEvidence.objects[0]!;
    const originalPath = join(directory, ...object.path.split('/'));
    await rename(originalPath, `${originalPath}.temporary`);
    await mkdir(originalPath);
    await rename(`${originalPath}.temporary`, join(originalPath, 'version-1'));
    object.path += '/version-1';
    await save();
    expect((await verifyBackupManifest(manifestPath)).verifiedObjectCount).toBe(1);
  });

  it('rejects missing files, size and SHA-256 differences', async () => {
    const { directory, manifest, manifestPath, save } = await fixture();
    const object = manifest.scrapEvidence.objects[0]!;
    manifest.database.byteSize++;
    await save();
    await expect(verifyBackupManifest(manifestPath)).rejects.toThrow('Tamanho');
    manifest.database.byteSize--;
    manifest.database.sha256 = '0'.repeat(64);
    await save();
    await expect(verifyBackupManifest(manifestPath)).rejects.toThrow('SHA-256');
    manifest.database.sha256 = digest(Buffer.from('synthetic database backup'));
    object.path = 'objects/seller/synthetic/collection/synthetic/missing.jpg';
    object.storagePath = 'seller/synthetic/collection/synthetic/missing.jpg';
    await save();
    await expect(verifyBackupManifest(manifestPath)).rejects.toThrow('ausente');
    expect(directory).toContain('cirne-backup-verify-');
  });

  it('requires exact declared object count and the private bucket', async () => {
    const { manifest, manifestPath, save } = await fixture();
    manifest.scrapEvidence.expectedObjectCount = 0;
    await save();
    await expect(verifyBackupManifest(manifestPath)).rejects.toThrow('Cobertura');
    manifest.scrapEvidence.expectedObjectCount = 2;
    await save();
    await expect(verifyBackupManifest(manifestPath)).rejects.toThrow('Cobertura');
    manifest.scrapEvidence.expectedObjectCount = 1;
    manifest.scrapEvidence.bucket = 'visit-evidence';
    await save();
    await expect(verifyBackupManifest(manifestPath)).rejects.toThrow('Cobertura');
  });

  it('accepts an explicit zero-object snapshot without claiming complete DB coverage', async () => {
    const { manifest, manifestPath, save } = await fixture();
    manifest.scrapEvidence.objects = [];
    manifest.scrapEvidence.expectedObjectCount = 0;
    await save();
    expect(await verifyBackupManifest(manifestPath)).toMatchObject({
      expectedObjectCount: 0,
      verifiedObjectCount: 0,
      scrapEvidenceBytes: 0,
    });
  });

  it.each(['../outside.dump', '/outside.dump', 'C:/outside.dump', 'objects\\outside.dump',
    './database.dump', 'folder//database.dump', 'NUL.dump'])('rejects unsafe relative path %s', async (path) => {
    const { manifest, manifestPath, save } = await fixture();
    manifest.database.path = path;
    await save();
    await expect(verifyBackupManifest(manifestPath)).rejects.toThrow('Caminho');
  });

  it('rejects duplicate paths and duplicate Storage keys', async () => {
    const { manifest, manifestPath, save } = await fixture();
    const object = manifest.scrapEvidence.objects[0]!;
    manifest.scrapEvidence.expectedObjectCount = 2;
    manifest.scrapEvidence.objects.push({ ...object });
    await save();
    await expect(verifyBackupManifest(manifestPath)).rejects.toThrow('duplicado');
    manifest.scrapEvidence.objects[1] = {
      ...object,
      storagePath: object.storagePath.toUpperCase(),
      path: `objects/${object.storagePath.toUpperCase()}`,
    };
    await save();
    await expect(verifyBackupManifest(manifestPath)).rejects.toThrow('duplicado');
  });

  it.skipIf(process.platform === 'win32')('rejects symlinked files', async () => {
    const { directory, manifest, manifestPath, save } = await fixture();
    await symlink(join(directory, 'database.dump'), join(directory, 'database-link.dump'), 'file');
    manifest.database.path = 'database-link.dump';
    await save();
    await expect(verifyBackupManifest(manifestPath)).rejects.toThrow('Link simbólico');
  });

  it('rejects symlinked directories, including Windows junctions', async () => {
    const { directory, manifest, manifestPath, save } = await fixture();
    const object = manifest.scrapEvidence.objects[0]!;
    object.storagePath = 'linked/synthetic/collection/synthetic/term.jpg';
    object.path = 'objects/linked/synthetic/collection/synthetic/term.jpg';
    await symlink(join(directory, 'objects', 'seller'), join(directory, 'objects', 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir');
    await save();
    await expect(verifyBackupManifest(manifestPath)).rejects.toThrow('Link simbólico');
  });

  it('rejects unsupported versions and inconsistent Storage path mapping', async () => {
    const { manifest, manifestPath, save } = await fixture();
    manifest.schemaVersion = 2;
    await save();
    await expect(verifyBackupManifest(manifestPath)).rejects.toThrow('Versão');
    manifest.schemaVersion = 1;
    manifest.scrapEvidence.objects[0]!.storagePath = 'different.jpg';
    await save();
    await expect(verifyBackupManifest(manifestPath)).rejects.toThrow('Mapeamento');
  });

  it('requires a schema migration and canonical UTC capture time', async () => {
    const { manifest, manifestPath, save } = await fixture();
    manifest.databaseMigration = 'unknown';
    await save();
    await expect(verifyBackupManifest(manifestPath)).rejects.toThrow('migração');
    manifest.databaseMigration = '20261006166000';
    await save();
    await expect(verifyBackupManifest(manifestPath)).rejects.toThrow('migração');
    manifest.databaseMigration = '20261006170000';
    manifest.capturedAt = '2026-10-07T12:00:00-03:00';
    await save();
    await expect(verifyBackupManifest(manifestPath)).rejects.toThrow('migração');
  });

  it('rejects oversized manifests before reading their contents', async () => {
    const { manifestPath } = await fixture();
    await truncate(manifestPath, 64 * 1024 * 1024 + 1);
    await expect(verifyBackupManifest(manifestPath)).rejects.toThrow('manifesto');
  });
});
