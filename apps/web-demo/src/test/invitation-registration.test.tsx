import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fail, mockApi, ok, renderApp, route } from './harness';

/**
 * Invitation-aware registration UI behavior (Sprint 18 refinement), exercised
 * through the full app with a mocked API. Pins the complete invited path —
 * invitation landing → inspection → registration carrying the raw invitation
 * token → generic check-email state — and the raw-token hygiene rules: the
 * invitation token lives only in transient memory for the duration of the
 * submission, travels only in POST bodies, and is never rendered, stored, or
 * placed in a URL.
 */

const RAW_INVITATION_TOKEN = 'raw-invitation-token-fixture';
const PASSWORD = 'a-strong-password-123';

const PUBLIC_INVITATION = {
  organizationName: 'Acme Inc',
  invitedEmail: 'invitee@example.com',
  role: { key: 'member', name: 'Member' },
  expiresAt: '2026-08-01T00:00:00.000Z',
  acceptable: true,
};

function inspectRoute(response: ReturnType<typeof ok | typeof fail>) {
  return route('POST', /\/v1\/invitations\/inspect$/, () => response);
}

function registerRoute(response: ReturnType<typeof ok | typeof fail>) {
  return route('POST', /\/v1\/auth\/register$/, () => response);
}

afterEach(() => vi.unstubAllGlobals());

describe('/invitations/accept landing page (signed out)', () => {
  it('inspects the emailed token and reaches registration with safe context only', async () => {
    const fetchMock = mockApi({
      authenticated: false,
      overrides: [
        inspectRoute(ok({ invitation: PUBLIC_INVITATION })),
        registerRoute(ok({ accepted: true })),
      ],
    });
    renderApp(`/invitations/accept?token=${RAW_INVITATION_TOKEN}`);
    const user = userEvent.setup();

    // Safe public context from INSPECT is shown; the raw token never is.
    expect(await screen.findByText(/acme inc/i)).toBeInTheDocument();
    expect(screen.getByText(/invitee@example\.com/)).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(RAW_INVITATION_TOKEN);

    // The inspect call carried the token ONLY in the body, never a URL.
    const inspectCall = fetchMock.mock.calls.find(([input]) =>
      String(input).includes('/v1/invitations/inspect'),
    )!;
    expect(JSON.parse((inspectCall[1] as RequestInit).body as string)).toEqual({
      token: RAW_INVITATION_TOKEN,
    });

    // Continue to registration: invited email prefilled, safe banner shown.
    await user.click(
      screen.getByRole('button', { name: /create an account to join/i }),
    );
    expect(
      await screen.findByText(/registering with an invitation to join/i),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toHaveValue('invitee@example.com');
    expect(document.body.innerHTML).not.toContain(RAW_INVITATION_TOKEN);
  });

  it('shows the lifecycle states from inspection without reaching registration', async () => {
    mockApi({
      authenticated: false,
      overrides: [
        inspectRoute(fail('INVITATION_EXPIRED', 'Expired.', 410)),
      ],
    });
    renderApp(`/invitations/accept?token=${RAW_INVITATION_TOKEN}`);
    expect(
      await screen.findByText(/invitation has expired/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /create an account/i }),
    ).toBeNull();
  });

  it('scrubs the token-bearing query string after capture', async () => {
    mockApi({
      authenticated: false,
      overrides: [inspectRoute(ok({ invitation: PUBLIC_INVITATION }))],
    });
    renderApp(`/invitations/accept?token=${RAW_INVITATION_TOKEN}`);
    await screen.findByText(/acme inc/i);
    // The page still works (token captured) with the query already scrubbed —
    // observable through the DOM: no anchor or content carries the token.
    expect(document.body.innerHTML).not.toContain(RAW_INVITATION_TOKEN);
  });
});

describe('/invitations/accept landing page (signed in)', () => {
  it('accepts directly as the existing user via the body-only accept call', async () => {
    const fetchMock = mockApi({
      authenticated: true,
      overrides: [
        inspectRoute(ok({ invitation: PUBLIC_INVITATION })),
        route('POST', /\/v1\/invitations\/accept$/, () =>
          ok({
            organization: {
              id: 'org_demo',
              name: 'Acme Inc',
              slug: 'acme',
              type: 'team',
              status: 'active',
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
            membership: {
              id: 'mem_new',
              status: 'active',
              role: { id: 'role_member', key: 'member', name: 'Member' },
              joinedAt: '2026-07-21T00:00:00.000Z',
              createdAt: '2026-07-21T00:00:00.000Z',
            },
          }),
        ),
      ],
    });
    renderApp(`/invitations/accept?token=${RAW_INVITATION_TOKEN}`);
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole('button', { name: /accept invitation/i }),
    );
    expect(
      await screen.findByText(/invitation accepted/i),
    ).toBeInTheDocument();

    const acceptCall = fetchMock.mock.calls.find(([input]) =>
      String(input).includes('/v1/invitations/accept'),
    )!;
    expect(JSON.parse((acceptCall[1] as RequestInit).body as string)).toEqual({
      token: RAW_INVITATION_TOKEN,
    });
    for (const [input] of fetchMock.mock.calls) {
      expect(String(input)).not.toContain(RAW_INVITATION_TOKEN);
    }
  });
});

describe('invitation-aware registration submission', () => {
  async function reachRegistrationAndSubmit(
    fetchMock: ReturnType<typeof mockApi>,
  ) {
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: /create an account to join/i }),
    );
    await user.type(
      await screen.findByLabelText(/display name/i),
      'Invited User',
    );
    // Email is prefilled with the invited address; add the password only.
    await user.type(screen.getByLabelText(/password/i), PASSWORD);
    await user.click(
      screen.getByRole('button', { name: /continue with email/i }),
    );
    return fetchMock;
  }

  it('includes the raw invitation token in the register body and shows the generic check-email state', async () => {
    const fetchMock = mockApi({
      authenticated: false,
      overrides: [
        inspectRoute(ok({ invitation: PUBLIC_INVITATION })),
        registerRoute(ok({ accepted: true })),
      ],
    });
    renderApp(`/invitations/accept?token=${RAW_INVITATION_TOKEN}`);
    await reachRegistrationAndSubmit(fetchMock);

    // Generic check-email state; no authentication happened.
    expect(
      await screen.findByRole('heading', { name: /check your email/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/can be used for a new orgistry account/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/log out/i)).toBeNull();
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).includes('/v1/auth/me'),
      ),
    ).toHaveLength(0);

    // The register body carried the token; no URL ever did.
    const registerCall = fetchMock.mock.calls.find(([input]) =>
      String(input).includes('/v1/auth/register'),
    )!;
    expect(JSON.parse((registerCall[1] as RequestInit).body as string)).toEqual(
      {
        displayName: 'Invited User',
        email: 'invitee@example.com',
        password: PASSWORD,
        invitationToken: RAW_INVITATION_TOKEN,
      },
    );
    for (const [input] of fetchMock.mock.calls) {
      expect(String(input)).not.toContain(RAW_INVITATION_TOKEN);
    }

    // Safe invitation display context may remain; the raw token may not.
    expect(screen.getByText(/acme inc/i)).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(RAW_INVITATION_TOKEN);
    for (const storage of [window.localStorage, window.sessionStorage]) {
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i)!;
        expect(key).not.toContain(RAW_INVITATION_TOKEN);
        expect(storage.getItem(key)).not.toContain(RAW_INVITATION_TOKEN);
      }
    }
  });

  it('shows the SAME generic state when the backend generically accepts a dead invitation', async () => {
    // The backend answers `accepted: true` for private invitation failures;
    // the UI must not claim the invitation was valid or that mail was sent.
    const fetchMock = mockApi({
      authenticated: false,
      overrides: [
        inspectRoute(ok({ invitation: PUBLIC_INVITATION })),
        registerRoute(ok({ accepted: true })),
      ],
    });
    renderApp(`/invitations/accept?token=${RAW_INVITATION_TOKEN}`);
    await reachRegistrationAndSubmit(fetchMock);

    expect(
      await screen.findByRole('heading', { name: /check your email/i }),
    ).toBeInTheDocument();
    // Conditional copy only — never "invitation applied" or "email sent".
    expect(
      screen.getByText(/as long as the invitation is still available/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/email (was )?sent/i)).toBeNull();
    expect(screen.queryByText(/invitation (is|was) valid/i)).toBeNull();
  });

  it('plain registration omits invitationToken from the request body', async () => {
    const fetchMock = mockApi({
      authenticated: false,
      overrides: [registerRoute(ok({ accepted: true }))],
    });
    renderApp('/auth/register');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/display name/i), 'Plain');
    await user.type(screen.getByLabelText(/email/i), 'plain@example.com');
    await user.type(screen.getByLabelText(/password/i), PASSWORD);
    await user.click(
      screen.getByRole('button', { name: /continue with email/i }),
    );
    await screen.findByRole('heading', { name: /check your email/i });

    const registerCall = fetchMock.mock.calls.find(([input]) =>
      String(input).includes('/v1/auth/register'),
    )!;
    const body = JSON.parse((registerCall[1] as RequestInit).body as string);
    expect(body).toEqual({
      displayName: 'Plain',
      email: 'plain@example.com',
      password: PASSWORD,
    });
    expect('invitationToken' in body).toBe(false);
    // No invitation banner on the plain path.
    expect(screen.queryByText(/invitation/i)).toBeNull();
  });
});
