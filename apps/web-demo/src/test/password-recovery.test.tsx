import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';
import { App } from '../App';
import { fail, mockApi, ok, renderApp, route } from './harness';

/**
 * Password-recovery UI behavior (Sprint 17), exercised through the full app
 * with a mocked API. These tests pin two things: the forgot-password page is
 * enumeration-neutral (one generic outcome, no matter what the backend knows),
 * and the reset page mirrors the Sprint 16 token-hygiene posture — fragment
 * capture, fragment scrubbing, body-only transport, no storage, no rendering.
 */

const RAW_TOKEN = 'raw-reset-token-fixture';
const NEW_PASSWORD = 'brand-new-password-456';

describe('login page entry point', () => {
  it('exposes a forgot-password link that leads to the request form', async () => {
    mockApi({ authenticated: false });
    renderApp('/auth/login');
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole('link', { name: /forgot your password/i }),
    );

    expect(
      await screen.findByRole('button', { name: /send reset instructions/i }),
    ).toBeInTheDocument();
  });
});

describe('/auth/forgot-password request page', () => {
  function requestRoute(response: ReturnType<typeof ok | typeof fail>) {
    return route(
      'POST',
      /\/v1\/auth\/password-recovery\/request$/,
      () => response,
    );
  }

  async function submitEmail(email: string) {
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/email/i), email);
    await user.click(
      screen.getByRole('button', { name: /send reset instructions/i }),
    );
  }

  it('submits the email and shows the generic confirmation', async () => {
    const fetchMock = mockApi({
      authenticated: false,
      overrides: [requestRoute(ok({ accepted: true }))],
    });
    renderApp('/auth/forgot-password');

    await submitEmail('someone@example.com');

    expect(
      await screen.findByText(/if an account exists for that email/i),
    ).toBeInTheDocument();
    // The wording never asserts the account exists.
    expect(screen.queryByText(/account found/i)).toBeNull();

    const call = fetchMock.mock.calls.find(([input]) =>
      String(input).includes('/password-recovery/request'),
    )!;
    const init = call[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      email: 'someone@example.com',
    });
  });

  it('shows the identical generic confirmation regardless of account existence', async () => {
    // The backend answers identically either way; this pins that the UI adds
    // no distinguishing copy of its own.
    mockApi({
      authenticated: false,
      overrides: [requestRoute(ok({ accepted: true }))],
    });
    renderApp('/auth/forgot-password');
    await submitEmail('definitely-unknown@example.com');
    expect(
      await screen.findByText(/if an account exists for that email/i),
    ).toBeInTheDocument();
  });

  it('surfaces a rate-limit error safely', async () => {
    mockApi({
      authenticated: false,
      overrides: [
        requestRoute(fail('RATE_LIMITED', 'Too many requests.', 429)),
      ],
    });
    renderApp('/auth/forgot-password');

    await submitEmail('someone@example.com');

    expect(await screen.findByText(/too many requests/i)).toBeInTheDocument();
  });

  it('surfaces a validation error from the backend', async () => {
    mockApi({
      authenticated: false,
      overrides: [
        requestRoute(
          fail('VALIDATION_ERROR', 'A valid email address is required.', 400),
        ),
      ],
    });
    renderApp('/auth/forgot-password');

    await submitEmail('broken@example.com');

    expect(
      await screen.findByText(/valid email address is required/i),
    ).toBeInTheDocument();
  });
});

describe('/auth/reset-password completion page', () => {
  function completeRoute(response: ReturnType<typeof ok | typeof fail>) {
    return route(
      'POST',
      /\/v1\/auth\/password-recovery\/complete$/,
      () => response,
    );
  }

  async function fillAndSubmit(
    newPassword = NEW_PASSWORD,
    confirm = newPassword,
  ) {
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/^new password/i), newPassword);
    await user.type(screen.getByLabelText(/confirm new password/i), confirm);
    await user.click(screen.getByRole('button', { name: /reset password/i }));
  }

  it('reads the fragment token and submits it ONLY in the POST body', async () => {
    const fetchMock = mockApi({
      authenticated: false,
      overrides: [completeRoute(ok({ reset: true }))],
    });
    renderApp(`/auth/reset-password#token=${RAW_TOKEN}`);

    await fillAndSubmit();

    expect(
      await screen.findByText(/your password has been reset/i),
    ).toBeInTheDocument();
    const call = fetchMock.mock.calls.find(([input]) =>
      String(input).includes('/password-recovery/complete'),
    )!;
    const init = call[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      token: RAW_TOKEN,
      newPassword: NEW_PASSWORD,
    });
    // The token never appears in any request URL.
    for (const [input] of fetchMock.mock.calls) {
      expect(String(input)).not.toContain(RAW_TOKEN);
    }
  });

  it('links to sign-in after success', async () => {
    mockApi({
      authenticated: false,
      overrides: [completeRoute(ok({ reset: true }))],
    });
    renderApp(`/auth/reset-password#token=${RAW_TOKEN}`);

    await fillAndSubmit();
    await screen.findByText(/your password has been reset/i);

    expect(
      screen.getByRole('link', { name: /go to sign in/i }),
    ).toHaveAttribute('href', '/auth/login');
  });

  it('never persists the token to localStorage or sessionStorage and never renders it', async () => {
    mockApi({
      authenticated: false,
      overrides: [completeRoute(ok({ reset: true }))],
    });
    renderApp(`/auth/reset-password#token=${RAW_TOKEN}`);

    await fillAndSubmit();
    await screen.findByText(/your password has been reset/i);

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

  it('shows the invalid-token state with a link to request a new one', async () => {
    mockApi({
      authenticated: false,
      overrides: [
        completeRoute(fail('PASSWORD_RESET_TOKEN_INVALID', 'Not valid.', 404)),
      ],
    });
    renderApp(`/auth/reset-password#token=${RAW_TOKEN}`);

    await fillAndSubmit();

    expect(
      await screen.findByText(/reset link is not valid/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /request a new reset link/i }),
    ).toBeInTheDocument();
  });

  it('shows the expired-token state', async () => {
    mockApi({
      authenticated: false,
      overrides: [
        completeRoute(fail('PASSWORD_RESET_TOKEN_EXPIRED', 'Expired.', 410)),
      ],
    });
    renderApp(`/auth/reset-password#token=${RAW_TOKEN}`);

    await fillAndSubmit();

    expect(
      await screen.findByText(/reset link has expired/i),
    ).toBeInTheDocument();
  });

  it('shows the already-used state', async () => {
    mockApi({
      authenticated: false,
      overrides: [
        completeRoute(fail('PASSWORD_RESET_TOKEN_USED', 'Used.', 409)),
      ],
    });
    renderApp(`/auth/reset-password#token=${RAW_TOKEN}`);

    await fillAndSubmit();

    expect(
      await screen.findByText(/already been used/i),
    ).toBeInTheDocument();
  });

  it('keeps the form (and the token) on a password-policy validation error', async () => {
    const fetchMock = mockApi({
      authenticated: false,
      overrides: [
        completeRoute(
          fail(
            'VALIDATION_ERROR',
            'Password must be at least 12 characters.',
            400,
          ),
        ),
      ],
    });
    renderApp(`/auth/reset-password#token=${RAW_TOKEN}`);

    await fillAndSubmit('a-weak-but-typed-password');

    // Match the ERROR banner (role=alert) — the form's static hint text also
    // says "at least 12 characters", so an unscoped text query is ambiguous.
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/at least 12 characters/i);
    // The form is still there for a retry with the SAME captured token.
    expect(
      screen.getByRole('button', { name: /reset password/i }),
    ).toBeInTheDocument();
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
  });

  it('rejects mismatched passwords locally without calling the API', async () => {
    const fetchMock = mockApi({ authenticated: false });
    renderApp(`/auth/reset-password#token=${RAW_TOKEN}`);

    await fillAndSubmit(NEW_PASSWORD, 'different-password-000');

    expect(
      await screen.findByText(/passwords do not match/i),
    ).toBeInTheDocument();
    const completions = fetchMock.mock.calls.filter(([input]) =>
      String(input).includes('/password-recovery/complete'),
    );
    expect(completions).toHaveLength(0);
  });

  it('explains when the page is opened without a token', async () => {
    mockApi({ authenticated: false });
    renderApp('/auth/reset-password');

    expect(
      await screen.findByText(/needs the password reset link/i),
    ).toBeInTheDocument();
  });
});

describe('reset-token URL hygiene (fragment transport)', () => {
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
    mockApi({ authenticated: false });
    renderApp(
      `/auth/reset-password#token=${RAW_TOKEN}`,
      <>
        <App />
        <LocationProbe />
      </>,
    );

    // The form renders (token captured) with the fragment already scrubbed.
    await screen.findByRole('button', { name: /reset password/i });
    const probe = screen.getByTestId('location-probe');
    expect(probe.getAttribute('data-hash')).toBe('');
    expect(probe.getAttribute('data-search')).toBe('');
    expect(probe.getAttribute('data-pathname')).toBe('/auth/reset-password');
  });
});
