import { describe, expect, it } from 'vitest';
import {
  MAX_PROJECT_NAME_LENGTH,
  projectCreateRequestSchema,
  projectDeleteResponseSchema,
  projectListResponseSchema,
  projectSchema,
  projectUpdateRequestSchema,
} from './projects';

describe('projectCreateRequestSchema', () => {
  it('accepts a well-formed name', () => {
    expect(
      projectCreateRequestSchema.safeParse({ name: 'Launch Plan' }).success,
    ).toBe(true);
  });

  it('trims and rejects a blank name', () => {
    expect(projectCreateRequestSchema.safeParse({ name: '   ' }).success).toBe(
      false,
    );
  });

  it(`rejects a name longer than ${MAX_PROJECT_NAME_LENGTH}`, () => {
    expect(
      projectCreateRequestSchema.safeParse({
        name: 'a'.repeat(MAX_PROJECT_NAME_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it('ignores an organizationId smuggled into the body (route is the authority)', () => {
    const parsed = projectCreateRequestSchema.parse({
      name: 'Hijack',
      organizationId: 'org_attacker',
    });
    expect(parsed).toEqual({ name: 'Hijack' });
    expect('organizationId' in parsed).toBe(false);
  });
});

describe('projectUpdateRequestSchema', () => {
  it('accepts a narrow name update', () => {
    expect(
      projectUpdateRequestSchema.safeParse({ name: 'Renamed' }).success,
    ).toBe(true);
  });

  it('rejects a blank name', () => {
    expect(projectUpdateRequestSchema.safeParse({ name: '' }).success).toBe(
      false,
    );
  });
});

describe('project response DTOs', () => {
  const project = {
    id: 'prj_123',
    organizationId: 'org_1',
    name: 'Launch Plan',
    createdByUserId: 'user_1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('accepts the public Project DTO', () => {
    expect(projectSchema.safeParse(project).success).toBe(true);
  });

  it('does NOT carry soft-delete internals', () => {
    // The public DTO has a fixed key set; deleted markers never cross the
    // boundary because deleted projects are absent from active responses.
    expect(Object.keys(projectSchema.shape).sort()).toEqual(
      [
        'createdAt',
        'createdByUserId',
        'id',
        'name',
        'organizationId',
        'updatedAt',
      ].sort(),
    );
    expect('deletedAt' in projectSchema.shape).toBe(false);
    expect('deletedByUserId' in projectSchema.shape).toBe(false);
  });

  it('accepts a cursor-paginated list page', () => {
    expect(
      projectListResponseSchema.safeParse({
        items: [project],
        nextCursor: null,
        hasMore: false,
      }).success,
    ).toBe(true);
  });

  it('requires deleted: true on the delete acknowledgement', () => {
    expect(
      projectDeleteResponseSchema.safeParse({ id: 'prj_1', deleted: true })
        .success,
    ).toBe(true);
    expect(
      projectDeleteResponseSchema.safeParse({ id: 'prj_1', deleted: false })
        .success,
    ).toBe(false);
  });
});
