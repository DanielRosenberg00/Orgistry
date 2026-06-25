import { describe, expect, it } from 'vitest';
import { toAuditEvent } from './audit.mapper';
import type { AuditEventRecord } from './audit.types';

/**
 * Unit coverage for the audit DTO mapper: metadata sanitization (top-level and
 * nested), public event-type mapping, and honest actor/target shaping.
 */

function record(overrides: Partial<AuditEventRecord> = {}): AuditEventRecord {
  return {
    id: 'sevt_1',
    organizationId: 'org_1',
    eventType: 'project.created',
    actorType: 'user',
    actorUserId: 'user_1',
    metadata: {},
    requestId: 'req_1',
    createdAt: new Date('2026-06-25T00:00:00.000Z'),
    ...overrides,
  };
}

describe('toAuditEvent metadata sanitization', () => {
  it('drops sensitive TOP-LEVEL keys', () => {
    const event = toAuditEvent(
      record({
        metadata: {
          name: 'Launch',
          token: 'raw-token',
          tokenHash: 'hash',
          secret: 's',
          secretHash: 'sh',
          password: 'p',
          passwordHash: 'ph',
          authorization: 'Bearer x',
          cookie: 'sid=1',
          refreshToken: 'rt',
          apiKey: 'ak',
          apiKeySecret: 'aks',
          apiKeyHash: 'akh',
          invitationToken: 'it',
          invitationTokenHash: 'ith',
        },
      }),
      'org_1',
    );

    expect(event.metadata).toEqual({ name: 'Launch' });
  });

  it('drops sensitive NESTED keys in objects and arrays', () => {
    const event = toAuditEvent(
      record({
        metadata: {
          safe: 'ok',
          nested: { token: 'x', keep: 1 },
          list: [{ secret: 'y', label: 'z' }],
        },
      }),
      'org_1',
    );

    expect(event.metadata).toEqual({
      safe: 'ok',
      nested: { keep: 1 },
      list: [{ label: 'z' }],
    });
  });

  it('never returns raw tokens, hashes, secrets, cookies, or auth headers anywhere', () => {
    const event = toAuditEvent(
      record({
        metadata: {
          requestBody: { password: 'pw', authorization: 'Bearer t' },
          deeply: { nested: { refreshTokenHash: 'h' } },
        },
      }),
      'org_1',
    );

    const serialized = JSON.stringify(event).toLowerCase();
    for (const needle of [
      'raw-token',
      'bearer t',
      'pw',
      'refreshtokenhash',
    ]) {
      expect(serialized).not.toContain(needle.toLowerCase());
    }
  });
});

describe('toAuditEvent event-type mapping', () => {
  it('maps the prefixed member event names to public names', () => {
    expect(
      toAuditEvent(record({ eventType: 'org.member_role_changed' }), 'org_1')
        .type,
    ).toBe('member.role_changed');
    expect(
      toAuditEvent(record({ eventType: 'org.member_removed' }), 'org_1').type,
    ).toBe('member.removed');
  });

  it('passes through already-public event names', () => {
    expect(
      toAuditEvent(record({ eventType: 'plan.changed_demo' }), 'org_1').type,
    ).toBe('plan.changed_demo');
  });
});

describe('toAuditEvent actor shaping', () => {
  it('shapes a user actor with safe fields only', () => {
    const event = toAuditEvent(
      record({
        actorType: 'user',
        actorUserId: 'user_9',
        metadata: { actorMembershipId: 'mem_9' },
      }),
      'org_1',
    );
    expect(event.actor).toEqual({
      type: 'user',
      userId: 'user_9',
      membershipId: 'mem_9',
      apiKeyId: null,
      label: null,
    });
  });

  it('collapses an anonymous actor to unknown without inventing identity', () => {
    const event = toAuditEvent(
      record({ actorType: 'anonymous', actorUserId: null }),
      'org_1',
    );
    expect(event.actor.type).toBe('unknown');
    expect(event.actor.userId).toBeNull();
  });
});

describe('toAuditEvent target shaping', () => {
  it('derives the project target id from metadata', () => {
    const event = toAuditEvent(
      record({
        eventType: 'project.created',
        metadata: { targetProjectId: 'prj_5' },
      }),
      'org_1',
    );
    expect(event.target).toEqual({ type: 'project', id: 'prj_5', label: null });
  });

  it('derives a membership target for member events', () => {
    const event = toAuditEvent(
      record({
        eventType: 'org.member_role_changed',
        metadata: { membershipId: 'mem_3', targetUserId: 'user_3' },
      }),
      'org_1',
    );
    expect(event.target.type).toBe('membership');
    expect(event.target.id).toBe('mem_3');
  });

  it('labels a plan target with the new plan key and exposes no id', () => {
    const event = toAuditEvent(
      record({
        eventType: 'plan.changed_demo',
        metadata: { previousPlanKey: 'free', newPlanKey: 'business' },
      }),
      'org_1',
    );
    expect(event.target).toEqual({
      type: 'plan',
      id: null,
      label: 'business',
    });
  });
});

describe('toAuditEvent API key events — safe ids survive, secrets do not', () => {
  it('keeps the api_key target id for api_key.created and api_key.revoked', () => {
    for (const eventType of ['api_key.created', 'api_key.revoked']) {
      const event = toAuditEvent(
        record({
          eventType,
          metadata: {
            actorMembershipId: 'mem_1',
            targetType: 'api_key',
            targetKeyId: 'key_42',
            // Secret-bearing fields a careless producer might attach:
            apiKeySecret: 'super-secret-value',
            apiKeyHash: 'deadbeefhash',
            apiKeyValue: 'raw-key-value',
          },
        }),
        'org_1',
      );

      expect(event.target).toEqual({
        type: 'api_key',
        id: 'key_42',
        label: null,
      });

      const serialized = JSON.stringify(event).toLowerCase();
      for (const leak of [
        'super-secret-value',
        'deadbeefhash',
        'raw-key-value',
      ]) {
        expect(serialized).not.toContain(leak);
      }
      // The safe opaque id is still present in metadata after sanitization.
      expect(event.metadata.targetKeyId).toBe('key_42');
    }
  });

  it('exposes an api_key actor id from a safe metadata id, never a secret', () => {
    const event = toAuditEvent(
      record({
        actorType: 'api_key',
        actorUserId: null,
        eventType: 'api_key.revoked',
        metadata: { targetKeyId: 'key_7', apiKeySecret: 'nope' },
      }),
      'org_1',
    );
    expect(event.actor.type).toBe('api_key');
    expect(event.actor.apiKeyId).toBe('key_7');
    expect(JSON.stringify(event)).not.toContain('nope');
  });
});

describe('toAuditEvent never exposes internal/correlation fields', () => {
  it('injects no mapping-internal keys and drops request-correlation keys', () => {
    const event = toAuditEvent(
      record({
        metadata: {
          name: 'Launch',
          ipAddress: '203.0.113.1',
          userAgent: 'curl/8',
          sessionId: 'sess_1',
        },
      }),
      'org_1',
    );
    // ip/user-agent/session are stripped; the mapper adds no synthetic keys
    // (e.g. no `__persistedType`) — metadata is exactly the safe producer field.
    expect(event.metadata).toEqual({ name: 'Launch' });
    expect('__persistedType' in event.metadata).toBe(false);
  });
});

describe('toAuditEvent tenant boundary', () => {
  it('always stamps the authoritative org id, never the raw row value', () => {
    const event = toAuditEvent(
      record({ organizationId: 'org_OTHER' }),
      'org_AUTHORITATIVE',
    );
    expect(event.organizationId).toBe('org_AUTHORITATIVE');
  });
});
