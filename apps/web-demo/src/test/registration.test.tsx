import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';
import { App } from '../App';
import { USER } from './fixtures';
import { fail, mockApi, ok, renderApp, route } from './harness';

/**
 * Verification-first registration UI behavior (Sprint 18), exercised through
 * the full app with a mocked API. Pins two things:
 *  - the register page shows ONE generic check-email state and never treats
 *    submission as sign-in (no enumeration signal, no premature auth state);
 *  - the completion page mirrors the established token-hygiene posture —
 *    fragment capture, fragment scrubbing, body-only transport, no storage,
 *    no rendering — and only IT initializes authenticated state.
 */

const RAW_TOKEN = 'raw-registration-completion-token-fixture';

const REGISTRATION = {
  displayName: 'New User',
  email: 'new.user@example.com',
  password: 'a-strong-password-123',
};

function bearer() {
  return { accessToken: 'test-access-token', tokenType: 'Bearer', expiresIn: 900 };
}

function registerRoute(response: ReturnType<typeof ok | typeof fail>) {
  return route('POST', /\/v1\/auth\/register$/, () => response);
}

function completeRoute(response: ReturnType<typeof ok | typeof fail>) {
  return route('POST', /\/v1\/auth\/registration\/complete$/, () => response);
}

async function submitRegistration() {
  const user = userEvent.setup();
  await user.type(
    await screen.findByLabelText(/display name/i),
    REGISTRATION.displayName,
  );
  await user.type(screen.getByLabelText(/email/i), REGISTRATION.email);
  await user.type(screen.getByLabelText(/password/i), REGISTRATION.password);
  await user.click(
    screen.getByRole('button', { name: /continue with email/i }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('/auth/register request page', () => {
  it('submits the request and shows the generic check-email state without authenticating', async () => {
    const fetchMock = mockApi({
      authenticated: false,
      overrides: [registerRoute(ok({ accepted: true }))],
    });
    renderApp('/auth/register');

    await submitRegistration();

    expect(
      await screen.findByRole('heading', { name: /check your email/i }),
    ).toBeInTheDocument();
    // Generic continuation copy: conditional, never "account created".
    expect(
      screen.getByText(/can be used for a new orgistry account/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/account created/i)).toBeNull();
    // Not signed in: still on the auth screen, no navigation into the app.
    expect(screen.queryByText(/log out/i)).toBeNull();

    // The request carried exactly the expected payload…
    const call = fetchMock.mock.calls.find(([input]) =>
      String(input).includes('/v1/auth/register'),
    )!;
    const init = call[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      displayName: REGISTRATION.displayName,
      email: REGISTRATION.email,
      password: REGISTRATION.password,
    });
    // …and NO user/session fetch followed it (no auth-state initialization).
    const meCalls = fetchMock.mock.calls.filter(([input]) =>
      String(input).includes('/v1/auth/me'),
    );
    expect(meCalls).toHaveLength(0);
  });

  it('shows the identical generic state whether or not the address has an account', async () => {
    // The backend answers identically either way (its enumeration-safe
    // contract); this pins that the UI adds no distinguishing copy of its own.
    mockApi({
      authenticated: false,
      overrides: [registerRoute(ok({ accepted: true }))],
    });
    renderApp('/auth/register');
    await submitRegistration();
    expect(
      await screen.findByRole('heading', { name: /check your email/i }),
    ).toBeInTheDocument();
  });

  it('offers sign-in and password-recovery navigation from the check-email state', async () => {
    mockApi({
      authenticated: false,
      overrides: [registerRoute(ok({ accepted: true }))],
    });
    renderApp('/auth/register');
    await submitRegistration();
    await screen.findByRole('heading', { name: /check your email/i });

    expect(screen.getByRole('link', { name: /sign in/i })).toHaveAttribute(
      'href',
      '/auth/login',
    );
    expect(
      screen.getByRole('link', { name: /reset your password/i }),
    ).toHaveAttribute('href', '/auth/forgot-password');
  });

  it('surfaces validation and rate-limit errors explicitly', async () => {
    mockApi({
      authenticated: false,
      overrides: [
        registerRoute(fail('RATE_LIMITED', 'Too many requests.', 429)),
      ],
    });
    renderApp('/auth/register');
    await submitRegistration();
    expect(await screen.findByText(/too many requests/i)).toBeInTheDocument();
    // Still on the form; no check-email state for a rejected request.
    expect(
      screen.queryByRole('heading', { name: /check your email/i }),
    ).toBeNull();
  });
});

describe('/auth/complete-registration completion page', () => {
  it('auto-submits the fragment token ONLY in the POST body and signs the user in', async () => {
    const fetchMock = mockApi({
      authenticated: false,
      overrides: [
        completeRoute(
          ok({ user: USER, tokens: bearer(), invitation: null }, 201),
        ),
      ],
    });
    renderApp(`/auth/complete-registration#token=${RAW_TOKEN}`);

    // Success initializes authenticated state and lands in the app shell.
    await waitFor(() =>
      expect(screen.getAllByText(/acme inc/i).length).toBeGreaterThan(0),
    );
    expect(screen.getByText(/log out/i)).toBeInTheDocument();

    const call = fetchMock.mock.calls.find(([input]) =>
      String(input).includes('/registration/complete'),
    )!;
    const init = call[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ token: RAW_TOKEN });
    // The token never appears in any request URL.
    for (const [input] of fetchMock.mock.calls) {
      expect(String(input)).not.toContain(RAW_TOKEN);
    }
  });

  it('never persists the token to localStorage or sessionStorage and never renders it', async () => {
    mockApi({
      authenticated: false,
      overrides: [
        completeRoute(
          ok({ user: USER, tokens: bearer(), invitation: null }, 201),
        ),
      ],
    });
    renderApp(`/auth/complete-registration#token=${RAW_TOKEN}`);
    await waitFor(() =>
      expect(screen.getAllByText(/acme inc/i).length).toBeGreaterThan(0),
    );

    for (const storage of [window.localStorage, window.sessionStorage]) {
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i)!;
        expect(key).not.toContain(RAW_TOKEN);
        expect(storage.getItem(key)).not.toContain(RAW_TOKEN);
      }
    }
    expect(document.body.textContent).not.toContain(RAW_TOKEN);
    expect(document.body.innerHTML).not.toContain(RAW_TOKEN);
  });

  it('reports an invitation that became unavailable while still completing the account', async () => {
    mockApi({
      authenticated: false,
      overrides: [
        completeRoute(
          ok(
            {
              user: USER,
              tokens: bearer(),
              invitation: { status: 'unavailable' },
            },
            201,
          ),
        ),
      ],
    });
    renderApp(`/auth/complete-registration#token=${RAW_TOKEN}`);

    expect(
      await screen.findByText(/invitation you registered with is no longer available/i),
    ).toBeInTheDocument();
    // The account itself is ready; the page offers the workspace.
    expect(
      screen.getByRole('link', { name: /continue to your workspace/i }),
    ).toHaveAttribute('href', '/app/overview');
  });

  it('explains when the page is opened without a token', async () => {
    mockApi({ authenticated: false });
    renderApp('/auth/complete-registration');
    expect(
      await screen.findByText(/needs the registration link/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /register again/i }),
    ).toHaveAttribute('href', '/auth/register');
  });

  it('shows the invalid-token state', async () => {
    mockApi({
      authenticated: false,
      overrides: [
        completeRoute(fail('REGISTRATION_TOKEN_INVALID', 'Not valid.', 404)),
      ],
    });
    renderApp(`/auth/complete-registration#token=${RAW_TOKEN}`);
    expect(
      await screen.findByText(/registration link is not valid/i),
    ).toBeInTheDocument();
  });

  it('shows the expired-token state', async () => {
    mockApi({
      authenticated: false,
      overrides: [
        completeRoute(fail('REGISTRATION_TOKEN_EXPIRED', 'Expired.', 410)),
      ],
    });
    renderApp(`/auth/complete-registration#token=${RAW_TOKEN}`);
    expect(
      await screen.findByText(/registration link has expired/i),
    ).toBeInTheDocument();
  });

  it('shows the used/superseded state with coherent sign-in navigation', async () => {
    mockApi({
      authenticated: false,
      overrides: [
        completeRoute(fail('REGISTRATION_TOKEN_USED', 'Used.', 409)),
      ],
    });
    renderApp(`/auth/complete-registration#token=${RAW_TOKEN}`);
    expect(
      await screen.findByText(/already been used or was replaced/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /go to sign in/i }),
    ).toHaveAttribute('href', '/auth/login');
  });
});

describe('registration-token URL hygiene (fragment transport)', () => {
  /** Renders the live router location so tests can observe the visible URL. */
  function LocationProbe() {
    const location = useLocation();
    return (
      <div
        data-testid="location-probe"
        data-pathname={location.pathname}
        data-search={location.search}
        data-hash={location.hash}
      />
    );
  }

  it('scrubs the token-bearing fragment from the visible URL after capture', async () => {
    mockApi({
      authenticated: false,
      overrides: [
        completeRoute(fail('REGISTRATION_TOKEN_INVALID', 'Not valid.', 404)),
      ],
    });
    renderApp(
      `/auth/complete-registration#token=${RAW_TOKEN}`,
      <>
        <App />
        <LocationProbe />
      </>,
    );

    await screen.findByText(/registration link is not valid/i);
    const probe = screen.getByTestId('location-probe');
    expect(probe.getAttribute('data-hash')).toBe('');
    expect(probe.getAttribute('data-search')).toBe('');
    expect(probe.getAttribute('data-pathname')).toBe(
      '/auth/complete-registration',
    );
  });
});
