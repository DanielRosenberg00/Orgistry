/**
 * Client-side backup encryption (Sprint 28, ORG-PR-005).
 *
 * WHY CLIENT-SIDE
 * Storage-side encryption ("encryption at rest" offered by an object-storage
 * provider) and client-side encryption are NOT equivalent and this repository
 * never describes them as such. Storage-side encryption protects against
 * someone walking off with the provider's disks; it does not protect against
 * anyone who can read the bucket, because the provider decrypts transparently
 * for every authorised reader. An Orgistry logical backup contains every user,
 * organization, and audit row plus password hashes, refresh-token hashes, and
 * API-key secret hashes — so the artifact is encrypted HERE, before it ever
 * leaves the host, with a key the storage provider never sees.
 *
 * FORMAT (magic "ORGBK1")
 *
 *   offset 0   6 bytes    magic            "ORGBK1"
 *   offset 6   4 bytes    uint32 BE        header length
 *   offset 10  N bytes    header JSON      authenticated as AES-GCM AAD
 *   ...        M bytes    ciphertext
 *   last       16 bytes   GCM auth tag
 *
 * The header is additional authenticated data, so the recorded plaintext
 * digest, artifact name, and key identity cannot be altered without failing
 * the tag check. It contains no secret: the key is identified by a keyed
 * FINGERPRINT, never by the key itself.
 *
 * The auth tag lives in a trailer because AES-GCM only produces it once the
 * whole plaintext has been consumed. Decryption reads it by absolute offset
 * rather than buffering the stream tail, which is possible because these
 * artifacts are always files of known size.
 *
 * KEY HANDLING — the whole point of this module
 *   * The key is 32 raw bytes, supplied as 64 hex characters or 44 base64
 *     characters in a mode-0600 file that is NEVER committed and never passed
 *     as a command argument.
 *   * No function here prints, logs, returns, or serialises the key. The only
 *     key-derived value that leaves this module is `encryptionKeyId`, an HMAC
 *     fingerprint that identifies WHICH key encrypted an artifact without
 *     revealing it.
 *   * Losing the key means losing every backup encrypted with it. That is a
 *     deliberate, documented tradeoff — see docs/backup-and-restore.md.
 */

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const BACKUP_CRYPTO_MAGIC = Buffer.from('ORGBK1', 'ascii');
export const BACKUP_CRYPTO_CIPHER = 'aes-256-gcm';

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_LENGTH_BYTES = 4;
const HEADER_OFFSET = BACKUP_CRYPTO_MAGIC.length + HEADER_LENGTH_BYTES;

/** Guard against a malformed file claiming an absurd header length. */
const MAX_HEADER_BYTES = 8 * 1024;

/**
 * Parse the contents of a key file into 32 raw bytes.
 *
 * Accepts hex or base64 so an operator can generate the key with whichever
 * tool their host has (`openssl rand -hex 32`, `openssl rand -base64 32`).
 * Errors deliberately describe the SHAPE that was wrong and never echo input.
 */
export function parseEncryptionKey(keyText) {
  const trimmed = String(keyText ?? '').trim();
  if (trimmed.length === 0) {
    throw new Error('backup encryption key is empty');
  }

  let key;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    key = Buffer.from(trimmed, 'hex');
  } else if (/^[A-Za-z0-9+/]{43}=$/.test(trimmed)) {
    key = Buffer.from(trimmed, 'base64');
  } else {
    throw new Error(
      'backup encryption key must be 64 hex characters or 44 base64 characters (32 bytes); ' +
        'generate one with: openssl rand -hex 32',
    );
  }

  if (key.length !== KEY_BYTES) {
    throw new Error(`backup encryption key must decode to ${KEY_BYTES} bytes, got ${key.length}`);
  }
  return key;
}

/**
 * Non-secret fingerprint of a key.
 *
 * An HMAC over a fixed label rather than a plain digest of the key, so the
 * published value is not a hash an attacker can grind against a candidate key
 * list. Recorded in every artifact header and in the backup catalog, which is
 * how an operator can tell "this artifact predates the key rotation" apart from
 * "this artifact is corrupt".
 */
export function encryptionKeyId(key) {
  return createHmac('sha256', key).update('orgistry-backup-key-id').digest('hex').slice(0, 16);
}

function encodeHeader(header) {
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  if (json.length > MAX_HEADER_BYTES) {
    throw new Error('backup artifact header is implausibly large; refusing to write it');
  }
  const length = Buffer.alloc(HEADER_LENGTH_BYTES);
  length.writeUInt32BE(json.length, 0);
  return { json, framed: Buffer.concat([BACKUP_CRYPTO_MAGIC, length, json]) };
}

/**
 * Encrypt `sourcePath` to `destinationPath`.
 *
 * `plaintextSha256` is the digest tooling/db-backup.sh already computed for the
 * artifact. Carrying it inside the authenticated header is what lets a restore
 * verify the RECOVERED bytes against the digest recorded at BACKUP time, rather
 * than against a digest that travelled beside the artifact and could have been
 * replaced along with it.
 */
export async function encryptFile({ sourcePath, destinationPath, key, plaintextSha256, plaintextName }) {
  const { size } = await stat(sourcePath);
  const iv = randomBytes(IV_BYTES);
  const header = {
    version: 1,
    cipher: BACKUP_CRYPTO_CIPHER,
    keyId: encryptionKeyId(key),
    iv: iv.toString('base64'),
    plaintextSha256,
    plaintextBytes: size,
    plaintextName,
  };
  const { framed } = encodeHeader(header);

  const cipher = createCipheriv(BACKUP_CRYPTO_CIPHER, key, iv);
  cipher.setAAD(Buffer.from(JSON.stringify(header), 'utf8'));

  const destination = createWriteStream(destinationPath, { mode: 0o600 });
  destination.write(framed);
  await pipeline(createReadStream(sourcePath), cipher, destination, { end: false });

  const tag = cipher.getAuthTag();
  await new Promise((resolve, reject) => {
    destination.end(tag, (error) => (error ? reject(error) : resolve()));
  });

  return {
    keyId: header.keyId,
    plaintextBytes: size,
    encryptedSha256: await sha256File(destinationPath),
  };
}

/**
 * SHA-256 of a whole file, streamed.
 *
 * Lives here rather than in the object-store client because every caller wants
 * it for the same reason: an object PUT must declare the digest of exactly the
 * bytes it is about to send, and a restore must be able to prove the bytes it
 * fetched are those bytes.
 */
export async function sha256File(path) {
  const digest = createHash('sha256');
  await pipeline(createReadStream(path), digest);
  return digest.digest('hex');
}

async function readHeader(handle, fileSize) {
  if (fileSize < HEADER_OFFSET + TAG_BYTES) {
    throw new Error('encrypted backup artifact is truncated (shorter than its own header)');
  }
  const prefix = Buffer.alloc(HEADER_OFFSET);
  await handle.read(prefix, 0, HEADER_OFFSET, 0);
  if (!prefix.subarray(0, BACKUP_CRYPTO_MAGIC.length).equals(BACKUP_CRYPTO_MAGIC)) {
    throw new Error('not an Orgistry encrypted backup artifact (bad magic)');
  }

  const headerLength = prefix.readUInt32BE(BACKUP_CRYPTO_MAGIC.length);
  if (headerLength === 0 || headerLength > MAX_HEADER_BYTES) {
    throw new Error('encrypted backup artifact declares an implausible header length');
  }
  const dataStart = HEADER_OFFSET + headerLength;
  if (fileSize < dataStart + TAG_BYTES) {
    throw new Error('encrypted backup artifact is truncated (header extends past end of file)');
  }

  const raw = Buffer.alloc(headerLength);
  await handle.read(raw, 0, headerLength, HEADER_OFFSET);
  const header = JSON.parse(raw.toString('utf8'));
  if (header.cipher !== BACKUP_CRYPTO_CIPHER) {
    throw new Error(`unsupported backup cipher "${header.cipher}"`);
  }
  return { header, aad: raw, dataStart };
}

/** Read only the authenticated header — used to identify an artifact cheaply. */
export async function readEncryptedHeader(sourcePath) {
  const { size } = await stat(sourcePath);
  const handle = await open(sourcePath, 'r');
  try {
    const { header } = await readHeader(handle, size);
    return header;
  } finally {
    await handle.close();
  }
}

/**
 * Decrypt `sourcePath` to `destinationPath`.
 *
 * Fails closed in three independent ways: a wrong key or altered header fails
 * the GCM tag; a truncated file fails the length checks; and a plaintext whose
 * digest differs from the one recorded at backup time is rejected even if it
 * somehow decrypted. A partial output file is the caller's to clean up — the
 * throw happens before any caller treats the file as usable.
 */
export async function decryptFile({ sourcePath, destinationPath, key }) {
  const { size } = await stat(sourcePath);
  const handle = await open(sourcePath, 'r');
  let header;
  let aad;
  let dataStart;
  let tag;
  try {
    ({ header, aad, dataStart } = await readHeader(handle, size));
    tag = Buffer.alloc(TAG_BYTES);
    await handle.read(tag, 0, TAG_BYTES, size - TAG_BYTES);
  } finally {
    await handle.close();
  }

  const expectedKeyId = encryptionKeyId(key);
  if (typeof header.keyId === 'string' && header.keyId !== expectedKeyId) {
    throw new Error(
      `encrypted backup artifact was written with key ${header.keyId}, but the configured key is ${expectedKeyId}`,
    );
  }

  const decipher = createDecipheriv(BACKUP_CRYPTO_CIPHER, key, Buffer.from(header.iv, 'base64'));
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);

  const plaintextDigest = createHash('sha256');
  const ciphertextEnd = size - TAG_BYTES - 1;
  // A zero-byte plaintext is a legitimate artifact (an empty dump is refused by
  // tooling/db-backup.sh, but this module must not depend on that). `end` would
  // then precede `start`, which createReadStream rejects, so read nothing.
  const ciphertext =
    ciphertextEnd < dataStart
      ? Readable.from([])
      : createReadStream(sourcePath, { start: dataStart, end: ciphertextEnd });

  await pipeline(
    ciphertext,
    decipher,
    async function* observe(chunks) {
      for await (const chunk of chunks) {
        plaintextDigest.update(chunk);
        yield chunk;
      }
    },
    createWriteStream(destinationPath, { mode: 0o600 }),
  );

  const recovered = plaintextDigest.digest('hex');
  if (typeof header.plaintextSha256 === 'string') {
    const expected = Buffer.from(header.plaintextSha256, 'hex');
    const actual = Buffer.from(recovered, 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new Error('decrypted backup does not match the digest recorded when it was taken');
    }
  }

  return { header, plaintextSha256: recovered };
}
