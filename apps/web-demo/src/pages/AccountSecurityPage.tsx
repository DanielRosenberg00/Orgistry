import { useState } from 'react';
import { MIN_PASSWORD_LENGTH } from '@orgistry/contracts';
import type {
  ChangeEmailResponse,
  ChangePasswordResponse,
  EmailVerificationRequestResponse,
} from '@orgistry/contracts';
import { api } from '../api/client';
import { toApiError } from '../api/errors';
import { useAuth } from '../auth/useAuth';
import { ErrorBanner } from '../components/ErrorBanner';

/**
 * Account-security surface (Sprint 17): the authenticated user's email +
 * verification state, password change, and email change.
 *
 * Security posture:
 *  - both sensitive operations require the CURRENT password — the backend
 *    re-authenticates; this page never claims authorization on its own;
 *  - password fields are cleared after every submission (success or failure)
 *    and are never persisted anywhere;
 *  - all displayed state (email, verification) derives from the backend via
 *    `useAuth().user`; after an email change the current user is re-fetched so
 *    the new address and its unverified state come from the server.
 */
export function AccountSecurityPage() {
  return (
    <div>
      <h1>Account security</h1>
      <CurrentEmailCard />
      <ChangePasswordCard />
      <ChangeEmailCard />
    </div>
  );
}

type ResendState =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'sent' }
  | { kind: 'failed'; error: unknown };

function CurrentEmailCard() {
  const { user, refreshUser } = useAuth();
  const [resend, setResend] = useState<ResendState>({ kind: 'idle' });

  if (!user) return null;

  async function handleResend() {
    setResend({ kind: 'pending' });
    try {
      const response = await api.post<EmailVerificationRequestResponse>(
        '/v1/auth/email-verification/request',
      );
      if (response.alreadyVerified) {
        await refreshUser();
        setResend({ kind: 'idle' });
        return;
      }
      setResend({ kind: 'sent' });
    } catch (caught) {
      setResend({ kind: 'failed', error: caught });
    }
  }

  return (
    <div className="card" style={{ marginBottom: '1rem' }}>
      <h2>Email</h2>
      <p>
        <strong>{user.email}</strong>{' '}
        {user.emailVerified ? (
          <span className="badge">verified</span>
        ) : (
          <span className="badge">unverified</span>
        )}
      </p>
      {!user.emailVerified && (
        <div>
          <p className="muted">
            This address has not been verified yet. Verification is advisory —
            your account stays usable — but confirming it proves the address
            belongs to you.
          </p>
          <button
            className="btn btn-sm"
            onClick={handleResend}
            disabled={resend.kind === 'pending'}
          >
            {resend.kind === 'pending' ? 'Sending…' : 'Resend verification email'}
          </button>
          {resend.kind === 'sent' && (
            <span className="muted" style={{ marginLeft: '0.5rem' }}>
              Verification email sent.
            </span>
          )}
          {resend.kind === 'failed' && (
            <div style={{ marginTop: '0.5rem' }}>
              <ErrorBanner error={resend.error} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ChangePasswordCard() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [success, setSuccess] = useState(false);
  const [pending, setPending] = useState(false);

  function clearPasswordFields() {
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSuccess(false);
    if (newPassword !== confirmPassword) {
      setError(new Error('The new passwords do not match.'));
      setNewPassword('');
      setConfirmPassword('');
      return;
    }
    setPending(true);
    try {
      await api.post<ChangePasswordResponse>('/v1/auth/change-password', {
        currentPassword,
        newPassword,
      });
      setSuccess(true);
    } catch (caught) {
      setError(toApiError(caught));
    } finally {
      // Passwords never linger in the form, whatever the outcome.
      clearPasswordFields();
      setPending(false);
    }
  }

  return (
    <div className="card" style={{ marginBottom: '1rem' }}>
      <h2>Change password</h2>
      <p className="muted">
        Requires your current password. All other signed-in sessions are signed
        out; this one stays active.
      </p>
      {error != null && <ErrorBanner error={error} />}
      {success && (
        <div className="banner banner-success" role="status">
          Password changed. Other sessions have been signed out.
        </div>
      )}
      <form onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="pw-current">Current password</label>
          <input
            id="pw-current"
            type="password"
            className="input"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="pw-new">New password</label>
          <input
            id="pw-new"
            type="password"
            className="input"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            minLength={MIN_PASSWORD_LENGTH}
            required
          />
          <span className="muted" style={{ fontSize: '0.8rem' }}>
            At least {MIN_PASSWORD_LENGTH} characters.
          </span>
        </div>
        <div className="field">
          <label htmlFor="pw-confirm">Confirm new password</label>
          <input
            id="pw-confirm"
            type="password"
            className="input"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            minLength={MIN_PASSWORD_LENGTH}
            required
          />
        </div>
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? 'Changing…' : 'Change password'}
        </button>
      </form>
    </div>
  );
}

function ChangeEmailCard() {
  const { refreshUser } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [success, setSuccess] = useState(false);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSuccess(false);
    setPending(true);
    try {
      await api.post<ChangeEmailResponse>('/v1/auth/change-email', {
        currentPassword,
        newEmail: newEmail.trim(),
      });
      // Adopt the backend's new state (address + cleared verification).
      await refreshUser();
      setSuccess(true);
      setNewEmail('');
    } catch (caught) {
      setError(toApiError(caught));
    } finally {
      setCurrentPassword('');
      setPending(false);
    }
  }

  return (
    <div className="card">
      <h2>Change email</h2>
      <p className="muted">
        Requires your current password. The new address starts unverified and a
        verification email is sent to it.
      </p>
      {error != null && <ErrorBanner error={error} />}
      {success && (
        <div className="banner banner-success" role="status">
          Email changed. A verification email has been sent to the new address.
        </div>
      )}
      <form onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="em-current">Current password</label>
          <input
            id="em-current"
            type="password"
            className="input"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="em-new">New email</label>
          <input
            id="em-new"
            type="email"
            className="input"
            value={newEmail}
            onChange={(event) => setNewEmail(event.target.value)}
            required
          />
        </div>
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? 'Changing…' : 'Change email'}
        </button>
      </form>
    </div>
  );
}
