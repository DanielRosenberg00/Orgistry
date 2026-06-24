import { describe, expect, it } from 'vitest';
import {
  personalWorkspaceSlugBase,
  slugify,
} from './organization.provisioning';

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Acme Inc')).toBe('acme-inc');
  });

  it('collapses non-alphanumeric runs and trims hyphens', () => {
    expect(slugify('  Hello,   World!!  ')).toBe('hello-world');
  });

  it('falls back when no usable characters remain', () => {
    expect(slugify('   ')).toBe('workspace');
    expect(slugify('🚀🚀', 'team')).toBe('team');
  });

  it('produces a slug matching the contract pattern', () => {
    const pattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
    for (const input of ['Acme Inc', 'a--b', '__weird__', '123 Go']) {
      expect(pattern.test(slugify(input))).toBe(true);
    }
  });
});

describe('personalWorkspaceSlugBase', () => {
  it('derives from the display name with a random suffix', () => {
    const base = personalWorkspaceSlugBase('Ada Lovelace');
    expect(base).toMatch(/^ada-lovelace-[a-z0-9]{1,6}$/);
  });

  it('is collision-resistant across calls', () => {
    const a = personalWorkspaceSlugBase('Ada');
    const b = personalWorkspaceSlugBase('Ada');
    expect(a).not.toBe(b);
  });
});
