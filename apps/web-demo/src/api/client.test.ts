import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, getAccessToken, setAccessToken } from './client';
import { ApiError } from './errors';

/**
 * API client unit tests: envelope unwrapping, error mapping (with request id),
 * bearer injection, the unexpected-response fallback, and the silent
 * refresh-on-401 retry.
 */

function stubFetch(impl: (url: string, init?: RequestInit) => MockHttp) {
  const mock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const res = impl(input.toString(), init);
    const headers = res.headers ?? {};
    return {
      status: res.status,
      ok: res.status < 400,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      json: async () => {
        if (res.nonJson) throw new Error('not json');
        return res.body;
      },
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

interface MockHttp {
  status: number;
  body?: unknown;
  /** Response headers keyed by lowercase name. */
  headers?: Record<string, string>;
  /** When true, `json()` rejects (simulates a non-JSON response). */
  nonJson?: boolean;
}

afterEach(() => {
  vi.unstubAllGlobals();
  setAccessToken(null);
});

describe('api client', () => {
  it('unwraps a success envelope to its data', async () => {
    stubFetch(() => ({ status: 200, body: { ok: true, data: { value: 42 } } }));
    const data = await api.get<{ value: number }>('/v1/thing');
    expect(data).toEqual({ value: 42 });
  });

  it('maps an error envelope to a typed ApiError with the request id', async () => {
    stubFetch(() => ({
      status: 403,
      body: {
        ok: false,
        error: {
          code: 'FORBIDDEN',
          message: 'You do not have permission to perform this action.',
          requestId: 'req_abc_123',
        },
      },
    }));

    const error = await api.get('/v1/thing').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.code).toBe('FORBIDDEN');
    expect(apiError.status).toBe(403);
    expect(apiError.requestId).toBe('req_abc_123');
  });

  it('preserves structured error details (e.g. quota)', async () => {
    stubFetch(() => ({
      status: 409,
      body: {
        ok: false,
        error: {
          code: 'QUOTA_EXCEEDED',
          message: 'Quota reached.',
          requestId: 'req_q',
          details: { quota: 'max_projects', limit: 3, current: 3 },
        },
      },
    }));
    const error = (await api
      .post('/v1/thing', {})
      .catch((e: unknown) => e)) as ApiError;
    expect(error.details).toEqual({ quota: 'max_projects', limit: 3, current: 3 });
  });

  it('falls back to an unexpected error on a non-JSON response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        status: 500,
        ok: false,
        json: async () => {
          throw new Error('not json');
        },
      })),
    );
    const error = (await api
      .get('/v1/thing')
      .catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe('UNEXPECTED_ERROR');
  });

  it('injects the in-memory bearer token on authenticated requests', async () => {
    setAccessToken('tok-123');
    const mock = stubFetch(() => ({ status: 200, body: { ok: true, data: {} } }));
    await api.get('/v1/thing');
    const init = mock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer tok-123',
    );
  });

  it('silently refreshes once on 401 and retries the request', async () => {
    setAccessToken('expired');
    let thingCalls = 0;
    const mock = stubFetch((url) => {
      if (url.includes('/v1/auth/refresh')) {
        return {
          status: 200,
          body: {
            ok: true,
            data: {
              tokens: {
                accessToken: 'fresh',
                tokenType: 'Bearer',
                expiresIn: 900,
              },
            },
          },
        };
      }
      thingCalls += 1;
      if (thingCalls === 1) {
        return {
          status: 401,
          body: {
            ok: false,
            error: { code: 'UNAUTHORIZED', message: 'Expired.', requestId: 'r1' },
          },
        };
      }
      return { status: 200, body: { ok: true, data: { ok: true } } };
    });

    const data = await api.get('/v1/thing');
    expect(data).toEqual({ ok: true });
    expect(getAccessToken()).toBe('fresh');
    // 1st thing (401) + refresh + 2nd thing (200)
    expect(mock).toHaveBeenCalledTimes(3);
  });

  it('recovers the request id from the x-request-id header on a non-JSON response', async () => {
    stubFetch(() => ({
      status: 502,
      nonJson: true,
      headers: { 'x-request-id': 'req_from_header' },
    }));
    const error = (await api
      .get('/v1/thing')
      .catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe('UNEXPECTED_ERROR');
    expect(error.requestId).toBe('req_from_header');
  });

  it('does not loop: a failed refresh retries the request at most once', async () => {
    setAccessToken('expired');
    const mock = stubFetch((url) => {
      // Refresh always fails -> the session is unrecoverable.
      if (url.includes('/v1/auth/refresh')) {
        return {
          status: 401,
          body: {
            ok: false,
            error: {
              code: 'INVALID_REFRESH_TOKEN',
              message: 'Invalid.',
              requestId: 'r0',
            },
          },
        };
      }
      // The protected request always 401s.
      return {
        status: 401,
        body: {
          ok: false,
          error: { code: 'UNAUTHORIZED', message: 'Expired.', requestId: 'r1' },
        },
      };
    });

    const error = (await api
      .get('/v1/thing')
      .catch((e: unknown) => e)) as ApiError;
    // Original 401 surfaces; refresh failing must NOT recurse into more refreshes.
    expect(error.code).toBe('UNAUTHORIZED');
    // Exactly: 1st /v1/thing (401) + 1 refresh attempt (401). No retry, no loop.
    expect(mock).toHaveBeenCalledTimes(2);
    expect(getAccessToken()).toBeNull();
  });
});
