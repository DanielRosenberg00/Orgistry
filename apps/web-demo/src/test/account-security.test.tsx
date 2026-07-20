import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fail, mockApi, ok, renderApp, route } from './harness';
import { USER } from './fixtures';

/**
 * Account-security surface behavior (Sprint 17), exercised through the full
 * authenticated app with a mocked API. Pins the real backend contracts
 * (change-password / change-email request bodies), safe error display, the
 * post-change current-user refresh, and the password-field clearing policy.
 */

const CURRENT_PASSWORD = 'original-password-123';
const NEW_PASSWORD = 'rotated-password-456';
const UNVERIFIED_USER = { ...USER, emailVerified: false };

function meRoute(user: typeof USER) {
  return route('GET', /\/v1\/auth\/me$/, () => ok({ user }));
}

async function openAccountPage() {
  renderApp('/app/account');
  await screen.findByRole('heading', { name: /account security/i });
}

describe('account overview', () => {
  it('displays the current email and its verified state', async () => {
    mockApi();
    await openAccountPage();

    expect(screen.getByText(USER.email)).toBeInTheDocument();
    expect(screen.getAllByText(/verified/i).length).toBeGreaterThan(0);
  });

  it('offers the verification resend only while unverified', async () => {
    mockApi({
      overrides: [
        meRoute(UNVERIFIED_USER),
        route('POST', /\/v1\/auth\/email-verification\/request$/, () =>
          ok({ sent: true, alreadyVerified: false }),
        ),
      ],
    });
    await openAccountPage();
    const user = userEvent.setup();

    // Page-level resend action (the shell banner has its own).
    const resend = await screen.findByRole('button', {
      name: /resend verification email/i,
    });
    await user.click(resend);
    expect(
      await screen.findByText(/verification email sent/i),
    ).toBeInTheDocument();
  });

  it('hides the resend action for a verified user', async () => {
    mockApi();
    await openAccountPage();
    expect(
      screen.queryByRole('button', { name: /resend verification email/i }),
    ).toBeNull();
  });
});

describe('change password', () => {
  function passwordCard() {
    // The change-email card also has a "Current password" field, so every
    // query is scoped to this card.
    return within(
      screen
        .getByRole('heading', { name: /change password/i })
        .closest('.card') as HTMLElement,
    );
  }

  async function submitPasswordChange(
    current = CURRENT_PASSWORD,
    next = NEW_PASSWORD,
    confirm = next,
  ) {
    const user = userEvent.setup();
    const card = passwordCard();
    await user.type(card.getByLabelText(/current password/i), current);
    await user.type(card.getByLabelText(/^new password/i), next);
    await user.type(card.getByLabelText(/confirm new password/i), confirm);
    await user.click(card.getByRole('button', { name: /change password/i }));
  }

  it('submits the real backend contract and shows success', async () => {
    const fetchMock = mockApi({
      overrides: [
        route('POST', /\/v1\/auth\/change-password$/, () =>
          ok({ success: true }),
        ),
      ],
    });
    await openAccountPage();

    await submitPasswordChange();

    expect(
      await screen.findByText(/password changed/i),
    ).toBeInTheDocument();
    const call = fetchMock.mock.calls.find(([input]) =>
      String(input).includes('/change-password'),
    )!;
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({
      currentPassword: CURRENT_PASSWORD,
      newPassword: NEW_PASSWORD,
    });
  });

  it('clears every password field after submission', async () => {
    mockApi({
      overrides: [
        route('POST', /\/v1\/auth\/change-password$/, () =>
          ok({ success: true }),
        ),
      ],
    });
    await openAccountPage();

    await submitPasswordChange();
    await screen.findByText(/password changed/i);

    const card = passwordCard();
    expect(card.getByLabelText(/current password/i)).toHaveValue('');
    expect(card.getByLabelText(/^new password/i)).toHaveValue('');
    expect(card.getByLabelText(/confirm new password/i)).toHaveValue('');
  });

  it('shows the incorrect-current-password error without logging the user out', async () => {
    mockApi({
      overrides: [
        route('POST', /\/v1\/auth\/change-password$/, () =>
          fail('INVALID_CREDENTIALS', 'The current password is incorrect.', 400),
        ),
      ],
    });
    await openAccountPage();

    await submitPasswordChange('wrong-password-000');

    expect(
      await screen.findByText(/current password is incorrect/i),
    ).toBeInTheDocument();
    // Still on the authenticated page — no bounce to login.
    expect(
      screen.getByRole('heading', { name: /account security/i }),
    ).toBeInTheDocument();
  });

  it('rejects mismatched new passwords locally without calling the API', async () => {
    const fetchMock = mockApi();
    await openAccountPage();

    await submitPasswordChange(CURRENT_PASSWORD, NEW_PASSWORD, 'other-999');

    expect(
      await screen.findByText(/new passwords do not match/i),
    ).toBeInTheDocument();
    const calls = fetchMock.mock.calls.filter(([input]) =>
      String(input).includes('/change-password'),
    );
    expect(calls).toHaveLength(0);
  });
});

describe('change email', () => {
  const NEW_EMAIL = 'renamed@example.com';
  const RENAMED_USER = {
    ...USER,
    email: NEW_EMAIL,
    emailVerified: false,
  };

  function emailCard() {
    return within(
      screen
        .getByRole('heading', { name: /change email/i })
        .closest('.card') as HTMLElement,
    );
  }

  async function submitEmailChange(
    current = CURRENT_PASSWORD,
    email = NEW_EMAIL,
  ) {
    const user = userEvent.setup();
    const card = emailCard();
    await user.type(card.getByLabelText(/current password/i), current);
    await user.type(card.getByLabelText(/new email/i), email);
    await user.click(card.getByRole('button', { name: /change email/i }));
  }

  it('submits the real backend contract, refreshes the user, and shows the new state', async () => {
    let emailChanged = false;
    const fetchMock = mockApi({
      overrides: [
        route('GET', /\/v1\/auth\/me$/, () =>
          ok({ user: emailChanged ? RENAMED_USER : USER }),
        ),
        route('POST', /\/v1\/auth\/change-email$/, () => {
          emailChanged = true;
          return ok({ user: RENAMED_USER });
        }),
      ],
    });
    await openAccountPage();

    await submitEmailChange();

    expect(await screen.findByText(/email changed/i)).toBeInTheDocument();
    // The refreshed backend state drives the display: new address, unverified.
    // (The address also appears in the shell's unverified banner.)
    const addresses = await screen.findAllByText(NEW_EMAIL);
    expect(addresses.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/^unverified$/i)).toBeInTheDocument();

    const call = fetchMock.mock.calls.find(([input]) =>
      String(input).includes('/change-email'),
    )!;
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({
      currentPassword: CURRENT_PASSWORD,
      newEmail: NEW_EMAIL,
    });
    // A /me refresh happened after the change.
    await waitFor(() => {
      const meCalls = fetchMock.mock.calls.filter(([input]) =>
        String(input).includes('/v1/auth/me'),
      );
      expect(meCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('shows the duplicate-email conflict safely', async () => {
    mockApi({
      overrides: [
        route('POST', /\/v1\/auth\/change-email$/, () =>
          fail(
            'EMAIL_ALREADY_REGISTERED',
            'An account with this email already exists.',
            409,
          ),
        ),
      ],
    });
    await openAccountPage();

    await submitEmailChange();

    expect(
      await screen.findByText(/already exists/i),
    ).toBeInTheDocument();
  });

  it('shows the incorrect-current-password error and clears the password field', async () => {
    mockApi({
      overrides: [
        route('POST', /\/v1\/auth\/change-email$/, () =>
          fail('INVALID_CREDENTIALS', 'The current password is incorrect.', 400),
        ),
      ],
    });
    await openAccountPage();

    await submitEmailChange('wrong-password-000');

    expect(
      await screen.findByText(/current password is incorrect/i),
    ).toBeInTheDocument();
    expect(emailCard().getByLabelText(/current password/i)).toHaveValue('');
  });
});
