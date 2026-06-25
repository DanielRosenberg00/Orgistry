import type { ReactElement } from 'react';
import { render, type RenderResult } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { App } from '../App';
import { AuthProvider } from '../auth/AuthProvider';
import { OrganizationProvider } from '../organization/OrganizationProvider';
import { createQueryClient } from '../queryClient';
import {
  API_KEY,
  AUDIT_EVENT,
  ENTITLEMENTS,
  INVITATION,
  MEMBER,
  ORGANIZATION,
  PLAN,
  PROJECT,
  USER,
  effectivePermissions,
} from './fixtures';

/** A canned envelope response for the mocked `fetch`. */
export interface MockResponse {
  status: number;
  body: unknown;
}

/** Build a success envelope response. */
export function ok(data: unknown, status = 200): MockResponse {
  return { status, body: { ok: true, data } };
}

/** Build an error envelope response (matches the backend error shape). */
export function fail(
  code: string,
  message: string,
  status: number,
  details?: unknown,
  requestId = 'req_test_abc',
): MockResponse {
  const error: Record<string, unknown> = { code, message, requestId };
  if (details !== undefined) error.details = details;
  return { status, body: { ok: false, error } };
}

type Responder = (url: URL, init: RequestInit) => MockResponse;

interface Route {
  method: string;
  pattern: RegExp;
  respond: Responder;
}

/** Declare a route override for the mock API. */
export function route(
  method: string,
  pattern: RegExp,
  respond: Responder,
): Route {
  return { method, pattern, respond };
}

export interface MockApiOptions {
  /** Whether the boot-time refresh succeeds (i.e. there is a session). */
  authenticated?: boolean;
  /** Route overrides, tried before the defaults (first match wins). */
  overrides?: Route[];
}

/**
 * Install a mocked `fetch` that answers the Orgistry API with canned envelopes.
 *
 * Defaults cover the full authenticated admin journey; tests prepend
 * `overrides` to tailor specific responses (errors, permission sets, …). The
 * mock only implements what the API client reads: `status` and `json()`.
 */
export function mockApi(options: MockApiOptions = {}): ReturnType<typeof vi.fn> {
  const authenticated = options.authenticated ?? true;
  const routes: Route[] = [...(options.overrides ?? []), ...defaultRoutes(authenticated)];

  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = (init?.method ?? 'GET').toUpperCase();
    const match = routes.find(
      (r) => r.method === method && r.pattern.test(url.pathname),
    );
    const response: MockResponse = match
      ? match.respond(url, init ?? {})
      : { status: 404, body: { ok: false, error: { code: 'NOT_FOUND', message: `No mock for ${method} ${url.pathname}`, requestId: 'req_mock' } } };
    return {
      status: response.status,
      ok: response.status < 400,
      json: async () => response.body,
    } as Response;
  });

  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function defaultRoutes(authenticated: boolean): Route[] {
  return [
    route('POST', /\/v1\/auth\/refresh$/, () =>
      authenticated
        ? ok({ tokens: bearer() })
        : fail('INVALID_REFRESH_TOKEN', 'Invalid refresh token.', 401),
    ),
    route('GET', /\/v1\/auth\/me$/, () => ok({ user: USER })),
    route('POST', /\/v1\/auth\/login$/, () =>
      ok({ user: USER, tokens: bearer() }),
    ),
    route('POST', /\/v1\/auth\/logout$/, () => ok({ success: true })),
    route('GET', /\/v1\/organizations$/, () =>
      ok({ items: [ORGANIZATION], nextCursor: null, hasMore: false }),
    ),
    route('GET', /\/permissions\/effective$/, () =>
      ok(effectivePermissions()),
    ),
    route('GET', /\/members$/, () =>
      ok({ items: [MEMBER], nextCursor: null, hasMore: false }),
    ),
    route('GET', /\/projects$/, () =>
      ok({ items: [PROJECT], nextCursor: null, hasMore: false }),
    ),
    route('GET', /\/invitations$/, () =>
      ok({ items: [INVITATION], nextCursor: null, hasMore: false }),
    ),
    route('GET', /\/api-keys$/, () =>
      ok({ items: [API_KEY], nextCursor: null, hasMore: false }),
    ),
    route('GET', /\/audit-events$/, () =>
      ok({
        items: [AUDIT_EVENT],
        nextCursor: null,
        hasMore: false,
        meta: { auditRetentionDays: 30 },
      }),
    ),
    route('GET', /\/plan$/, () => ok(PLAN)),
    route('GET', /\/entitlements$/, () => ok(ENTITLEMENTS)),
  ];
}

function bearer() {
  return { accessToken: 'test-access-token', tokenType: 'Bearer', expiresIn: 900 };
}

/** Render the full app (providers + router) at a starting route. */
export function renderApp(
  initialRoute: string,
  ui: ReactElement = <App />,
): RenderResult {
  const queryClient = createQueryClient();
  return render(
    <MemoryRouter initialEntries={[initialRoute]}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <OrganizationProvider>{ui}</OrganizationProvider>
        </AuthProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}
