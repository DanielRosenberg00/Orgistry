import { describe, expect, it } from 'vitest';
import {
  API_KEY_SCOPES,
  API_KEY_SCOPE_LIST,
  apiKeyCreateRequestSchema,
  apiKeyScopeSchema,
  apiKeySchema,
  externalProjectSchema,
} from './api-keys';

describe('API key scopes', () => {
  it('defines exactly the v1 scope set (projects:read)', () => {
    expect(API_KEY_SCOPE_LIST).toEqual(['projects:read']);
    expect(API_KEY_SCOPES.projectsRead).toBe('projects:read');
  });

  it('accepts a valid scope and rejects an invalid one', () => {
    expect(apiKeyScopeSchema.safeParse('projects:read').success).toBe(true);
    expect(apiKeyScopeSchema.safeParse('projects:write').success).toBe(false);
    expect(apiKeyScopeSchema.safeParse('admin').success).toBe(false);
  });
});

describe('apiKeyCreateRequestSchema', () => {
  it('accepts a well-formed request', () => {
    const parsed = apiKeyCreateRequestSchema.safeParse({
      name: 'CI reader',
      scopes: ['projects:read'],
    });
    expect(parsed.success).toBe(true);
  });

  it('requires at least one scope', () => {
    expect(
      apiKeyCreateRequestSchema.safeParse({ name: 'No scopes', scopes: [] })
        .success,
    ).toBe(false);
  });

  it('rejects an invalid scope value', () => {
    expect(
      apiKeyCreateRequestSchema.safeParse({
        name: 'Bad scope',
        scopes: ['projects:write'],
      }).success,
    ).toBe(false);
  });

  it('rejects a blank name', () => {
    expect(
      apiKeyCreateRequestSchema.safeParse({
        name: '   ',
        scopes: ['projects:read'],
      }).success,
    ).toBe(false);
  });

  it('accepts an optional ISO expiresAt and rejects a non-ISO one', () => {
    expect(
      apiKeyCreateRequestSchema.safeParse({
        name: 'Expiring',
        scopes: ['projects:read'],
        expiresAt: '2099-01-01T00:00:00.000Z',
      }).success,
    ).toBe(true);
    expect(
      apiKeyCreateRequestSchema.safeParse({
        name: 'Expiring',
        scopes: ['projects:read'],
        expiresAt: 'not-a-date',
      }).success,
    ).toBe(false);
  });

  it('ignores an organizationId smuggled into the body (route is the authority)', () => {
    const parsed = apiKeyCreateRequestSchema.parse({
      name: 'Hijack',
      scopes: ['projects:read'],
      organizationId: 'org_attacker',
    });
    expect('organizationId' in parsed).toBe(false);
  });
});

describe('apiKeySchema (DTO)', () => {
  it('has no field for the raw secret or the secret hash', () => {
    const shape = Object.keys(apiKeySchema.shape);
    expect(shape).not.toContain('secret');
    expect(shape).not.toContain('secretHash');
    // It DOES carry the display-safe prefix and a derived status.
    expect(shape).toContain('displayPrefix');
    expect(shape).toContain('status');
  });
});

describe('externalProjectSchema (DTO)', () => {
  it('exposes only the safe external fields', () => {
    expect(Object.keys(externalProjectSchema.shape).sort()).toEqual(
      ['createdAt', 'id', 'name', 'organizationId', 'updatedAt'].sort(),
    );
  });
});
