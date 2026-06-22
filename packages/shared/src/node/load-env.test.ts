import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findWorkspaceRoot, loadWorkspaceEnv } from './load-env';

// Unique keys so the test never collides with real environment variables, and
// is cleaned up after each case to avoid leaking into other tests.
const KEY_FROM_FILE = '__ORGISTRY_TEST_FROM_FILE__';
const KEY_EXISTING = '__ORGISTRY_TEST_EXISTING__';

/** Create a throwaway directory tree that looks like a workspace root. */
function makeWorkspace(withEnv: string | null): string {
  const root = mkdtempSync(join(tmpdir(), 'orgistry-env-'));
  writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'x'\n");
  if (withEnv !== null) {
    writeFileSync(join(root, '.env'), withEnv);
  }
  return root;
}

const created: string[] = [];

afterEach(() => {
  delete process.env[KEY_FROM_FILE];
  delete process.env[KEY_EXISTING];
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('findWorkspaceRoot', () => {
  it('finds the directory containing pnpm-workspace.yaml', () => {
    const root = makeWorkspace(null);
    created.push(root);
    expect(findWorkspaceRoot(root)).toBe(root);
  });

  it('returns null when no workspace marker exists up the tree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orgistry-noroot-'));
    created.push(dir);
    expect(findWorkspaceRoot(dir)).toBeNull();
  });
});

describe('loadWorkspaceEnv', () => {
  it('loads values from the workspace-root .env', () => {
    const root = makeWorkspace(`${KEY_FROM_FILE}=loaded\n`);
    created.push(root);

    loadWorkspaceEnv(root);

    expect(process.env[KEY_FROM_FILE]).toBe('loaded');
  });

  it('does not override an already-set environment variable', () => {
    process.env[KEY_EXISTING] = 'from-shell';
    const root = makeWorkspace(`${KEY_EXISTING}=from-file\n`);
    created.push(root);

    loadWorkspaceEnv(root);

    expect(process.env[KEY_EXISTING]).toBe('from-shell');
  });

  it('is a safe no-op when .env is absent', () => {
    const root = makeWorkspace(null);
    created.push(root);

    expect(() => loadWorkspaceEnv(root)).not.toThrow();
    expect(process.env[KEY_FROM_FILE]).toBeUndefined();
  });

  it('is a safe no-op when no workspace root is found', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orgistry-noroot-'));
    created.push(dir);

    expect(() => loadWorkspaceEnv(dir)).not.toThrow();
  });
});
