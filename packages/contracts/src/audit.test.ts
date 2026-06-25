import { describe, expect, it } from 'vitest';
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from './pagination';
import {
  AUDIT_EVENT_TYPES,
  auditEventSchema,
  auditListQuerySchema,
  auditListResponseSchema,
} from './audit';

describe('auditListQuerySchema', () => {
  it('defaults the limit and accepts no filters', () => {
    const parsed = auditListQuerySchema.parse({});
    expect(parsed.limit).toBe(DEFAULT_PAGE_LIMIT);
    expect(parsed.eventType).toBeUndefined();
  });

  it('coerces and caps the limit at the maximum', () => {
    expect(
      auditListQuerySchema.safeParse({ limit: MAX_PAGE_LIMIT + 1 }).success,
    ).toBe(false);
    expect(auditListQuerySchema.parse({ limit: '5' }).limit).toBe(5);
  });

  it('accepts every valid filter', () => {
    const parsed = auditListQuerySchema.parse({
      eventType: AUDIT_EVENT_TYPES.projectCreated,
      actorType: 'user',
      targetType: 'project',
      actorId: 'user_123',
      targetId: 'prj_123',
      createdAfter: '2026-01-01T00:00:00.000Z',
      createdBefore: '2026-02-01T00:00:00.000Z',
    });
    expect(parsed.eventType).toBe('project.created');
    expect(parsed.targetType).toBe('project');
  });

  it('rejects an unknown event type', () => {
    expect(
      auditListQuerySchema.safeParse({ eventType: 'auth.login_succeeded' })
        .success,
    ).toBe(false);
  });

  it('rejects an unknown actor or target type', () => {
    expect(auditListQuerySchema.safeParse({ actorType: 'robot' }).success).toBe(
      false,
    );
    expect(
      auditListQuerySchema.safeParse({ targetType: 'session' }).success,
    ).toBe(false);
  });

  it('rejects a non-ISO created bound', () => {
    expect(
      auditListQuerySchema.safeParse({ createdAfter: 'yesterday' }).success,
    ).toBe(false);
  });
});

describe('auditEventSchema', () => {
  it('accepts a fully shaped event', () => {
    const event = {
      id: 'sevt_1',
      organizationId: 'org_1',
      type: 'project.created',
      category: 'action' as const,
      actor: {
        type: 'user' as const,
        userId: 'user_1',
        membershipId: 'mem_1',
        apiKeyId: null,
        label: null,
      },
      target: { type: 'project' as const, id: 'prj_1', label: null },
      metadata: { name: 'Launch' },
      requestId: 'req_1',
      createdAt: '2026-06-25T00:00:00.000Z',
    };
    expect(auditEventSchema.parse(event)).toEqual(event);
  });

  it('rejects an out-of-catalog category', () => {
    expect(
      auditListResponseSchema.safeParse({
        items: [],
        nextCursor: null,
        hasMore: false,
        meta: { auditRetentionDays: -1 },
      }).success,
    ).toBe(false);
  });
});
