import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { PasswordRecoveryRequestResponse } from '@orgistry/contracts';
import { api } from '../api/client';
import { toApiError } from '../api/errors';
import { ErrorBanner } from '../components/ErrorBanner';

/**
 * Forgot-password request page (Sprint 17).
 *
 * Deliberately uninformative: after a submission the page shows the SAME
 * generic confirmation whether or not an account exists for the address — it
 * never suggests the account definitely exists, mirroring the backend's
 * enumeration-safe contract. The email is held only in component state and is
 * cleared once the request is accepted.
 */
export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      await api.post<PasswordRecoveryRequestResponse>(
        '/v1/auth/password-recovery/request',
        { email: email.trim() },
        { authenticated: false },
      );
      setSubmitted(true);
      setEmail('');
    } catch (caught) {
      // Validation and rate-limit errors are the only expected failures; both
      // are account-neutral, so showing them reveals nothing.
      setError(toApiError(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <h1>Reset your password</h1>
        {submitted ? (
          <>
            <div className="banner banner-success" role="status">
              If an account exists for that email, password reset instructions
              have been sent. The link expires after a short time — check your
              inbox.
            </div>
            <p className="muted" style={{ marginTop: '1rem' }}>
              <Link to="/auth/login">Back to sign in</Link>
            </p>
          </>
        ) : (
          <>
            <p className="muted">
              Enter your account email and we will send password reset
              instructions if an account exists for it.
            </p>
            {error != null && <ErrorBanner error={error} />}
            <form onSubmit={handleSubmit}>
              <div className="field">
                <label htmlFor="email">Email</label>
                <input
                  id="email"
                  type="email"
                  className="input"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                  autoFocus
                />
              </div>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={pending}
                style={{ width: '100%' }}
              >
                {pending ? 'Sending…' : 'Send reset instructions'}
              </button>
            </form>
            <p className="muted" style={{ marginTop: '1rem' }}>
              Remembered it? <Link to="/auth/login">Sign in</Link>.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
