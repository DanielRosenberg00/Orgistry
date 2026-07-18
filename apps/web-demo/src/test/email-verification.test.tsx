import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';
import { App } from '../App';
import { fail, mockApi, ok, renderApp, route } from './harness';
import { USER } from './fixtures';

/**
 * Email-verification UI behavior (Sprint 16), exercised through the full app
 * with a mocked API. Every displayed state derives from backend responses —
 * these tests also pin the security posture: the token is posted in a body,
 * never persisted to browser storage, and never rendered.
 */

const UNVERIFIED_USER = { ...USER, emailVerified: false };

function meRoute(user: typeof USER) {
  return route('GET', /\/v1\/auth\/me$/, () => ok({ user }));
}

describe('unverified-email banner', () => {
  it('shows the banner with a resend action for an unverified user', async () => {
    mockApi({ overrides: [meRoute(UNVERIFIED_USER)] });
    renderApp('/app/overview');

    expect(
      await screen.findByText(/verify your email address/i),
    ).toBeInTheDocument();
    expect(screen.getByText(UNVERIFIED_USER.email)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /resend email/i }),
    ).toBeInTheDocument();
  });

  it('does not show the banner for a verified user', async () => {
    mockApi();
    renderApp('/app/overview');

    // Wait for the authenticated shell, then assert the banner is absent.
    expect(await screen.findByText(/overview/i)).toBeInTheDocument();
    expect(screen.queryByText(/verify your email address/i)).toBeNull();
  });

  it('invokes the request endpoint and shows pending then sent states', async () => {
    let resolveRequest: (() => void) | null = null;
    const fetchMock = mockApi({
      overrides: [
        meRoute(UNVERIFIED_USER),
        route('POST', /\/v1\/auth\/email-verification\/request$/, () =>
          ok({ sent: true, alreadyVerified: false }),
        ),
      ],
    });
    // Delay only the verification request so the pending state is observable.
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/email-verification/request')) {
        await new Promise<void>((resolve) => {
          resolveRequest = resolve;
        });
      }
      return original(input, init);
    });

    renderApp('/app/overview');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /resend email/i }));

    expect(await screen.findByText('Sending…')).toBeInTheDocument();
    resolveRequest!();
    expect(await screen.findByText(/verification email sent/i)).toBeInTheDocument();

    const requestCall = fetchMock.mock.calls.find(([input]) =>
      String(input).includes('/email-verification/request'),
    );
    expect(requestCall).toBeTruthy();
    expect((requestCall![1] as RequestInit).method).toBe('POST');
  });

  it('shows a dedicated message when resend is rate limited', async () => {
    mockApi({
      overrides: [
        meRoute(UNVERIFIED_USER),
        route('POST', /\/v1\/auth\/email-verification\/request$/, () =>
          fail('RATE_LIMITED', 'Too many requests.', 429),
        ),
      ],
    });

    renderApp('/app/overview');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /resend email/i }));

    expect(await screen.findByText(/too many requests/i)).toBeInTheDocument();
  });

  it('shows a generic failure message on other errors', async () => {
    mockApi({
      overrides: [
        meRoute(UNVERIFIED_USER),
        route('POST', /\/v1\/auth\/email-verification\/request$/, () =>
          fail('INTERNAL_ERROR', 'Something broke.', 500),
        ),
      ],
    });

    renderApp('/app/overview');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /resend email/i }));

    expect(
      await screen.findByText(/could not send the email/i),
    ).toBeInTheDocument();
  });
});

describe('/auth/verify-email completion route', () => {
  const RAW_TOKEN = 'raw-verification-token-fixture';

  function completeRoute(response: ReturnType<typeof ok | typeof fail>) {
    return route(
      'POST',
      /\/v1\/auth\/email-verification\/complete$/,
      () => response,
    );
  }

  it('submits the token from the link in a POST body and shows success', async () => {
    const fetchMock = mockApi({
      authenticated: false,
      overrides: [completeRoute(ok({ verified: true }))],
    });

    renderApp(`/auth/verify-email#token=${RAW_TOKEN}`);

    expect(
      await screen.findByText(/your email address is verified/i),
    ).toBeInTheDocument();

    const call = fetchMock.mock.calls.find(([input]) =>
      String(input).includes('/email-verification/complete'),
    )!;
    const init = call[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ token: RAW_TOKEN });
    // The token travels in the body, never the API URL.
    expect(String(call[0])).not.toContain(RAW_TOKEN);
  });

  it('submits the token exactly once (single-use token, no double POST)', async () => {
    const fetchMock = mockApi({
      authenticated: false,
      overrides: [completeRoute(ok({ verified: true }))],
    });

    renderApp(`/auth/verify-email#token=${RAW_TOKEN}`);
    await screen.findByText(/your email address is verified/i);

    const completions = fetchMock.mock.calls.filter(([input]) =>
      String(input).includes('/email-verification/complete'),
    );
    expect(completions).toHaveLength(1);
  });

  it('never persists the token to localStorage or sessionStorage', async () => {
    mockApi({
      authenticated: false,
      overrides: [completeRoute(ok({ verified: true }))],
    });

    renderApp(`/auth/verify-email#token=${RAW_TOKEN}`);
    await screen.findByText(/your email address is verified/i);

    for (const storage of [window.localStorage, window.sessionStorage]) {
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i)!;
        expect(key).not.toContain(RAW_TOKEN);
        expect(storage.getItem(key)).not.toContain(RAW_TOKEN);
      }
    }
    // The token is also never rendered into the document.
    expect(document.body.textContent).not.toContain(RAW_TOKEN);
  });

  it('refreshes the current user after successful completion', async () => {
    const fetchMock = mockApi({
      overrides: [
        meRoute(UNVERIFIED_USER),
        completeRoute(ok({ verified: true })),
      ],
    });

    renderApp(`/auth/verify-email#token=${RAW_TOKEN}`);
    await screen.findByText(/your email address is verified/i);

    await waitFor(() => {
      const meCalls = fetchMock.mock.calls.filter(([input]) =>
        String(input).includes('/v1/auth/me'),
      );
      // Boot-time load + post-completion refresh.
      expect(meCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('shows the invalid-token state', async () => {
    mockApi({
      authenticated: false,
      overrides: [
        completeRoute(
          fail('EMAIL_VERIFICATION_TOKEN_INVALID', 'Not valid.', 404),
        ),
      ],
    });

    renderApp(`/auth/verify-email#token=${RAW_TOKEN}`);

    expect(
      await screen.findByText(/link is not valid/i),
    ).toBeInTheDocument();
  });

  it('shows the expired-token state', async () => {
    mockApi({
      authenticated: false,
      overrides: [
        completeRoute(
          fail('EMAIL_VERIFICATION_TOKEN_EXPIRED', 'Expired.', 410),
        ),
      ],
    });

    renderApp(`/auth/verify-email#token=${RAW_TOKEN}`);

    expect(await screen.findByText(/link has expired/i)).toBeInTheDocument();
  });

  it('shows the already-used state', async () => {
    mockApi({
      authenticated: false,
      overrides: [
        completeRoute(fail('EMAIL_VERIFICATION_TOKEN_USED', 'Used.', 409)),
      ],
    });

    renderApp(`/auth/verify-email#token=${RAW_TOKEN}`);

    expect(
      await screen.findByText(/already been used/i),
    ).toBeInTheDocument();
  });

  it('explains when the link is opened without a token', async () => {
    mockApi({ authenticated: false });

    renderApp('/auth/verify-email');

    expect(
      await screen.findByText(/needs the verification link/i),
    ).toBeInTheDocument();
  });
});

describe('verification-token URL hygiene (fragment transport)', () => {
  const RAW_TOKEN = 'raw-verification-token-fixture';

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

  function renderWithProbe(initialRoute: string) {
    return renderApp(
      initialRoute,
      <>
        <App />
        <LocationProbe />
      </>,
    );
  }

  it('removes the token-bearing fragment from the visible URL after capture', async () => {
    mockApi({
      authenticated: false,
      overrides: [
        route('POST', /\/v1\/auth\/email-verification\/complete$/, () =>
          ok({ verified: true }),
        ),
      ],
    });

    renderWithProbe(`/auth/verify-email#token=${RAW_TOKEN}`);
    await screen.findByText(/your email address is verified/i);

    const probe = screen.getByTestId('location-probe');
    expect(probe.getAttribute('data-hash')).toBe('');
    expect(probe.getAttribute('data-pathname')).toBe('/auth/verify-email');
  });

  it('never copies the token into a query string', async () => {
    const fetchMock = mockApi({
      authenticated: false,
      overrides: [
        route('POST', /\/v1\/auth\/email-verification\/complete$/, () =>
          ok({ verified: true }),
        ),
      ],
    });

    renderWithProbe(`/auth/verify-email#token=${RAW_TOKEN}`);
    await screen.findByText(/your email address is verified/i);

    // Not in the router-visible query string…
    const probe = screen.getByTestId('location-probe');
    expect(probe.getAttribute('data-search')).toBe('');
    // …and not in any request URL the app issued (body-only transport).
    for (const [input] of fetchMock.mock.calls) {
      expect(String(input)).not.toContain(RAW_TOKEN);
    }
  });
});
