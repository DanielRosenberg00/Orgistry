/**
 * Backup encryption contract (Sprint 28, ORG-PR-005).
 *
 * These tests exist to prove the properties an operator is asked to rely on
 * during a real recovery: the right key round-trips the exact bytes, and every
 * other case fails LOUDLY rather than producing a plausible-looking file.
 */
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  decryptFile,
  encryptFile,
  encryptionKeyId,
  parseEncryptionKey,
  readEncryptedHeader,
  sha256File,
} from './lib/backup-crypto.mjs';

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'orgistry-backup-crypto-'));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

async function writePlaintext(name: string, bytes: Buffer): Promise<string> {
  const path = join(workspace, name);
  await writeFile(path, bytes);
  return path;
}

describe('parseEncryptionKey', () => {
  it('accepts 64 hex characters', () => {
    expect(parseEncryptionKey(KEY_A)).toHaveLength(32);
  });

  it('accepts 44 base64 characters', () => {
    const base64 = randomBytes(32).toString('base64');
    expect(parseEncryptionKey(base64)).toHaveLength(32);
  });

  it('ignores surrounding whitespace, which a key file always has', () => {
    expect(parseEncryptionKey(`\n  ${KEY_A}\n`)).toHaveLength(32);
  });

  it('refuses an empty key rather than deriving one', () => {
    expect(() => parseEncryptionKey('   ')).toThrow(/empty/);
  });

  it('refuses a short key and names the required shape', () => {
    expect(() => parseEncryptionKey('deadbeef')).toThrow(/64 hex characters or 44 base64/);
  });

  it('never echoes the supplied value in the error', () => {
    const secretish = 'super-secret-but-wrong-shape';
    try {
      parseEncryptionKey(secretish);
      throw new Error('expected a throw');
    } catch (error) {
      expect(String(error)).not.toContain(secretish);
    }
  });
});

describe('encryptionKeyId', () => {
  it('is stable for one key and different for another', () => {
    const a = encryptionKeyId(parseEncryptionKey(KEY_A));
    expect(a).toBe(encryptionKeyId(parseEncryptionKey(KEY_A)));
    expect(a).not.toBe(encryptionKeyId(parseEncryptionKey(KEY_B)));
  });

  it('is not the key and is not a bare digest of the key', () => {
    const key = parseEncryptionKey(KEY_A);
    const id = encryptionKeyId(key);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(KEY_A).not.toContain(id);
    expect(createHash('sha256').update(key).digest('hex')).not.toContain(id);
  });
});

describe('encrypt/decrypt round trip', () => {
  it('recovers the exact bytes and reports the recorded provenance', async () => {
    const plaintext = randomBytes(256 * 1024);
    const source = await writePlaintext('source.dump', plaintext);
    const plaintextSha256 = await sha256File(source);
    const key = parseEncryptionKey(KEY_A);

    const encryptedPath = join(workspace, 'source.dump.enc');
    const written = await encryptFile({
      sourcePath: source,
      destinationPath: encryptedPath,
      key,
      plaintextSha256,
      plaintextName: 'source.dump',
    });

    expect(written.keyId).toBe(encryptionKeyId(key));
    expect(written.plaintextBytes).toBe(plaintext.length);
    expect(written.encryptedSha256).toBe(await sha256File(encryptedPath));

    const restoredPath = join(workspace, 'restored.dump');
    const result = await decryptFile({ sourcePath: encryptedPath, destinationPath: restoredPath, key });

    expect(await readFile(restoredPath)).toEqual(plaintext);
    expect(result.plaintextSha256).toBe(plaintextSha256);
    expect(result.header.plaintextName).toBe('source.dump');
    expect(result.header.cipher).toBe('aes-256-gcm');
  });

  it('round-trips an empty artifact without claiming success on nothing', async () => {
    const source = await writePlaintext('empty.dump', Buffer.alloc(0));
    const key = parseEncryptionKey(KEY_A);
    const encryptedPath = join(workspace, 'empty.enc');
    await encryptFile({
      sourcePath: source,
      destinationPath: encryptedPath,
      key,
      plaintextSha256: await sha256File(source),
      plaintextName: 'empty.dump',
    });
    const restoredPath = join(workspace, 'empty.out');
    await decryptFile({ sourcePath: encryptedPath, destinationPath: restoredPath, key });
    expect((await stat(restoredPath)).size).toBe(0);
  });

  it('writes the artifact owner-readable only', async () => {
    const source = await writePlaintext('mode.dump', randomBytes(64));
    const encryptedPath = join(workspace, 'mode.enc');
    await encryptFile({
      sourcePath: source,
      destinationPath: encryptedPath,
      key: parseEncryptionKey(KEY_A),
      plaintextSha256: await sha256File(source),
      plaintextName: 'mode.dump',
    });
    expect((await stat(encryptedPath)).mode & 0o077).toBe(0);
  });

  it('does not leave the plaintext recognisable in the artifact', async () => {
    const marker = Buffer.from('ORGISTRY-PLAINTEXT-MARKER-9f2a'.repeat(64));
    const source = await writePlaintext('marker.dump', marker);
    const encryptedPath = join(workspace, 'marker.enc');
    await encryptFile({
      sourcePath: source,
      destinationPath: encryptedPath,
      key: parseEncryptionKey(KEY_A),
      plaintextSha256: await sha256File(source),
      plaintextName: 'marker.dump',
    });
    const artifact = await readFile(encryptedPath);
    expect(artifact.includes('ORGISTRY-PLAINTEXT-MARKER')).toBe(false);
  });
});

describe('failure modes', () => {
  async function makeArtifact(): Promise<{ path: string; plaintext: Buffer }> {
    const plaintext = randomBytes(4096);
    const source = await writePlaintext('fail.dump', plaintext);
    const path = join(workspace, 'fail.enc');
    await encryptFile({
      sourcePath: source,
      destinationPath: path,
      key: parseEncryptionKey(KEY_A),
      plaintextSha256: await sha256File(source),
      plaintextName: 'fail.dump',
    });
    return { path, plaintext };
  }

  it('refuses the wrong key by identity, before spending time decrypting', async () => {
    const { path } = await makeArtifact();
    await expect(
      decryptFile({ sourcePath: path, destinationPath: join(workspace, 'out'), key: parseEncryptionKey(KEY_B) }),
    ).rejects.toThrow(/was written with key .*configured key is/);
  });

  it('refuses a truncated artifact', async () => {
    const { path } = await makeArtifact();
    const bytes = await readFile(path);
    const truncated = join(workspace, 'truncated.enc');
    await writeFile(truncated, bytes.subarray(0, bytes.length - 32));
    await expect(
      decryptFile({ sourcePath: truncated, destinationPath: join(workspace, 'out'), key: parseEncryptionKey(KEY_A) }),
    ).rejects.toThrow();
  });

  it('refuses a flipped ciphertext bit — integrity, not just confidentiality', async () => {
    const { path } = await makeArtifact();
    const bytes = await readFile(path);
    bytes[bytes.length - 64] ^= 0x01;
    const corrupted = join(workspace, 'corrupted.enc');
    await writeFile(corrupted, bytes);
    await expect(
      decryptFile({ sourcePath: corrupted, destinationPath: join(workspace, 'out'), key: parseEncryptionKey(KEY_A) }),
    ).rejects.toThrow();
  });

  it('refuses a tampered header — the recorded digest is authenticated', async () => {
    const { path } = await makeArtifact();
    const bytes = await readFile(path);
    const header = await readEncryptedHeader(path);
    const original = Buffer.from(JSON.stringify(header), 'utf8');
    const forged = Buffer.from(JSON.stringify({ ...header, plaintextName: 'fai1.dump' }), 'utf8');
    // A same-length forgery: proves the tag authenticates CONTENT, not length.
    expect(forged.length).toBe(original.length);
    forged.copy(bytes, 10);
    const tampered = join(workspace, 'tampered.enc');
    await writeFile(tampered, bytes);
    await expect(
      decryptFile({ sourcePath: tampered, destinationPath: join(workspace, 'out'), key: parseEncryptionKey(KEY_A) }),
    ).rejects.toThrow();
  });

  it('refuses a file that is not an Orgistry backup artifact at all', async () => {
    const notABackup = await writePlaintext('random.bin', randomBytes(512));
    await expect(readEncryptedHeader(notABackup)).rejects.toThrow(/bad magic/);
  });
});
