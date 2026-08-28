/**
 * Backup configuration contract (Sprint 28, ORG-PR-005).
 *
 * The properties under test are the ones that decide whether an operator's
 * mistake is caught at configuration time or at 03:00 during a recovery.
 */
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BACKUP_DEFAULTS,
  describeConfiguration,
  parseConfigFile,
  readSecretFile,
  resolveBackupConfiguration,
} from './lib/backup-config.mjs';

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'orgistry-backup-config-'));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

async function secretFile(name: string, value: string, mode = 0o600): Promise<string> {
  const path = join(workspace, name);
  await writeFile(path, `${value}\n`);
  await chmod(path, mode);
  return path;
}

function baseValues(overrides: Record<string, string> = {}) {
  return {
    ORGISTRY_BACKUP_ENVIRONMENT: 'staging-like',
    ORGISTRY_BACKUP_DATABASE_URL: 'postgres://backup:pw@db:5432/orgistry',
    ORGISTRY_BACKUP_ENCRYPTION_KEY: 'a'.repeat(64),
    ORGISTRY_BACKUP_DIR: join(workspace, 'backups'),
    ORGISTRY_BACKUP_STORE_ENDPOINT: 'https://ams3.digitaloceanspaces.com',
    ORGISTRY_BACKUP_STORE_REGION: 'ams3',
    ORGISTRY_BACKUP_STORE_BUCKET: 'orgistry-backups',
    ORGISTRY_BACKUP_STORE_ACCESS_KEY_ID: 'KEYID',
    ORGISTRY_BACKUP_STORE_SECRET_ACCESS_KEY: 'secret-value',
    ...overrides,
  };
}

describe('parseConfigFile', () => {
  it('reads KEY=VALUE lines, comments, and blanks', () => {
    expect(
      parseConfigFile(['# a comment', '', 'ORGISTRY_BACKUP_ENVIRONMENT=staging-like', 'ORGISTRY_BACKUP_DIR="/var/x"'].join('\n')),
    ).toEqual({ ORGISTRY_BACKUP_ENVIRONMENT: 'staging-like', ORGISTRY_BACKUP_DIR: '/var/x' });
  });

  it('does not expand anything — the file is parsed, never sourced', () => {
    const parsed = parseConfigFile('ORGISTRY_BACKUP_DIR=$(rm -rf /)');
    expect(parsed.ORGISTRY_BACKUP_DIR).toBe('$(rm -rf /)');
  });

  it('treats CRLF exactly like LF', () => {
    expect(parseConfigFile('ORGISTRY_BACKUP_ENVIRONMENT=staging-like\r\n')).toEqual({
      ORGISTRY_BACKUP_ENVIRONMENT: 'staging-like',
    });
  });

  it('refuses a line that is not KEY=VALUE', () => {
    expect(() => parseConfigFile('just some text', 'cfg')).toThrow(/cfg:1 is not a KEY=VALUE line/);
  });

  it('refuses a lower-case key rather than silently ignoring it', () => {
    expect(() => parseConfigFile('backup_dir=/var/x', 'cfg')).toThrow(/invalid key/);
  });
});

describe('readSecretFile', () => {
  it('reads and trims a mode-0600 file', async () => {
    const path = await secretFile('key', '  value  ');
    expect(readSecretFile(path, 'test secret')).toBe('value');
  });

  it('refuses a group-readable secret file and says how to fix it', async () => {
    const path = await secretFile('key', 'value', 0o640);
    expect(() => readSecretFile(path, 'test secret')).toThrow(/group- or world-readable.*chmod 600/s);
  });

  it('refuses an empty secret file rather than proceeding with nothing', async () => {
    const path = await secretFile('key', '');
    expect(() => readSecretFile(path, 'test secret')).toThrow(/is empty/);
  });

  it('names the path when the file is absent', () => {
    expect(() => readSecretFile(join(workspace, 'nope'), 'test secret')).toThrow(/not found at/);
  });
});

describe('resolveBackupConfiguration', () => {
  it('applies the documented defaults', () => {
    const configuration = resolveBackupConfiguration(baseValues());
    expect(configuration.retention.logicalDays).toBe(BACKUP_DEFAULTS.retainLogicalDays);
    expect(configuration.retention.logicalMinimum).toBe(BACKUP_DEFAULTS.retainLogicalMinimum);
    expect(configuration.retention.walDays).toBe(BACKUP_DEFAULTS.retainWalDays);
    expect(configuration.thresholds.backupMaxAgeHours).toBe(BACKUP_DEFAULTS.backupMaxAgeHours);
    expect(configuration.store.forcePathStyle).toBe(true);
  });

  it('namespaces stored objects by environment when no prefix is given', () => {
    expect(resolveBackupConfiguration(baseValues()).store.prefix).toBe('orgistry/staging-like');
  });

  it('refuses an environment name that would not be a stable object namespace', () => {
    expect(() => resolveBackupConfiguration(baseValues({ ORGISTRY_BACKUP_ENVIRONMENT: 'Staging Like' }))).toThrow(
      /lowercase dashed name/,
    );
  });

  it('prefers the *_FILE form and records which form was used', async () => {
    const configuration = resolveBackupConfiguration({
      ...baseValues(),
      ORGISTRY_BACKUP_ENCRYPTION_KEY_FILE: await secretFile('enc', 'b'.repeat(64)),
      ORGISTRY_BACKUP_STORE_SECRET_ACCESS_KEY_FILE: await secretFile('s3', 'from-file'),
    });
    expect(configuration.encryptionKey).toBe('b'.repeat(64));
    expect(configuration.store.secretAccessKey).toBe('from-file');
    expect(configuration.encryptionKeySource).toBe('file');
    expect(configuration.storeSecretSource).toBe('file');
    expect(configuration.databaseUrlSource).toBe('inline');
  });

  it('names the missing variable instead of failing later at the provider', () => {
    const values = baseValues();
    delete (values as Record<string, string>).ORGISTRY_BACKUP_STORE_BUCKET;
    expect(() => resolveBackupConfiguration(values)).toThrow(/ORGISTRY_BACKUP_STORE_BUCKET is not set/);
  });

  it('requires one of the two forms for every secret', () => {
    const values = baseValues();
    delete (values as Record<string, string>).ORGISTRY_BACKUP_ENCRYPTION_KEY;
    expect(() => resolveBackupConfiguration(values)).toThrow(
      /ORGISTRY_BACKUP_ENCRYPTION_KEY_FILE \(preferred\) or ORGISTRY_BACKUP_ENCRYPTION_KEY/,
    );
  });

  it('refuses a retention window that is not a positive number', () => {
    expect(() => resolveBackupConfiguration(baseValues({ ORGISTRY_BACKUP_RETAIN_WAL_DAYS: '0' }))).toThrow(
      /must be a positive number/,
    );
  });

  it('refuses an ambiguous boolean rather than guessing', () => {
    expect(() => resolveBackupConfiguration(baseValues({ ORGISTRY_BACKUP_STORE_PATH_STYLE: 'yes' }))).toThrow(
      /must be "on" or "off"/,
    );
  });
});

describe('describeConfiguration', () => {
  it('contains no secret value at all', () => {
    const configuration = resolveBackupConfiguration(baseValues());
    const described = JSON.stringify(describeConfiguration(configuration));
    expect(described).not.toContain('secret-value');
    expect(described).not.toContain('postgres://');
    expect(described).not.toContain('a'.repeat(64));
    expect(described).toContain('orgistry-backups');
  });

  it('reports where each credential came from, which is the auditable part', () => {
    const described = describeConfiguration(resolveBackupConfiguration(baseValues()));
    expect(described.credentialSources).toEqual({
      databaseUrl: 'inline',
      encryptionKey: 'inline',
      objectStoreSecret: 'inline',
    });
  });
});
