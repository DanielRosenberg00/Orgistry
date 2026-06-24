import { describe, expect, it } from 'vitest';
import {
  MAX_ORGANIZATION_NAME_LENGTH,
  organizationCreateRequestSchema,
  organizationListResponseSchema,
  organizationSchema,
  membershipSummarySchema,
} from './organizations';

describe('organizationCreateRequestSchema', () => {
  it('accepts a name with no slug (server will derive one)', () => {
    expect(
      organizationCreateRequestSchema.safeParse({ name: 'Acme Inc' }).success,
    ).toBe(true);
  });

  it('accepts a well-formed explicit slug', () => {
    expect(
      organizationCreateRequestSchema.safeParse({
        name: 'Acme',
        slug: 'acme-team-2',
      }).success,
    ).toBe(true);
  });

  it('rejects a blank name', () => {
    expect(
      organizationCreateRequestSchema.safeParse({ name: '   ' }).success,
    ).toBe(false);
  });

  it(`rejects a name longer than ${MAX_ORGANIZATION_NAME_LENGTH}`, () => {
    expect(
      organizationCreateRequestSchema.safeParse({
        name: 'a'.repeat(MAX_ORGANIZATION_NAME_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it('rejects slugs that are not lowercase-hyphen format', () => {
    for (const slug of ['Acme', 'acme team', 'acme_team', '-acme', 'acme-']) {
      expect(
        organizationCreateRequestSchema.safeParse({ name: 'Acme', slug })
          .success,
        `slug "${slug}" should be rejected`,
      ).toBe(false);
    }
  });
});

describe('organization response DTOs', () => {
  const organization = {
    id: 'org_123',
    name: 'Acme',
    slug: 'acme',
    type: 'team',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const membership = {
    id: 'mem_123',
    status: 'active',
    role: { id: 'role_owner', key: 'owner', name: 'Owner' },
    joinedAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  it('validates an organization DTO', () => {
    expect(organizationSchema.safeParse(organization).success).toBe(true);
  });

  it('validates a membership summary DTO', () => {
    expect(membershipSummarySchema.safeParse(membership).success).toBe(true);
  });

  it('rejects an unknown organization type', () => {
    expect(
      organizationSchema.safeParse({ ...organization, type: 'enterprise' })
        .success,
    ).toBe(false);
  });

  it('validates a cursor-paginated list response', () => {
    const result = organizationListResponseSchema.safeParse({
      items: [{ organization, membership }],
      nextCursor: null,
      hasMore: false,
    });
    expect(result.success).toBe(true);
  });
});
