import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { MIN_PASSWORD_LENGTH } from '@orgistry/contracts';
import type { PasswordRecoveryCompleteResponse } from '@orgistry/contracts';
import { api } from '../api/client';
import { toApiError } from '../api/errors';
import { ErrorBanner } from '../components/ErrorBanner';

/**
 * Password-reset completion page (Sprint 17): the target of the emailed link
 * `/auth/reset-password#token=…`.
 *
 * Token handling rules (identical to the Sprint 16 verification page):
 *  - the token travels in the URL FRAGMENT, so the browser never sends it to
 *    the web server, a proxy, an access log, or a `Referer` header — it is
 *    NEVER copied into a query string;
 *  - it is captured ONCE from the fragment into transient component memory —
 *    never localStorage, sessionStorage, or React context;
 *  - the fragment is immediately removed with a history replacement so the
 *    token does not linger in the address bar or history entry;
 *  - it is submitted to the backend only in the completion POST body (never a
 *    URL), is never rendered, and is DROPPED from memory once the reset
 *    settles.
 *
 * Unlike verification, completion is not automatic — the user first chooses a
 * new password, so the token is held until they submit. A successful reset
 * signs nobody in (the backend revoked every session); the page links to login.
 */

type PageState =
  | 'missing_token'
  | 'form'
  | 'submitting'
  | 'success'
  | 'invalid'
  | 'expired'
  | 'used';

/** Extract `token` from a `#token=…` fragment ("" or "#..." forms). */
function tokenFromFragment(hash: string): string | null {
  return new URLSearchParams(hash.replace(/^#/, '')).get('token');
}

export function ResetPasswordPage() {
  const location = useLocation();
  const navigate = useNavigate();
  // Capture the token ONCE into transient component memory. The router hash
  // mirrors window.location.hash under BrowserRouter.
  const [token, setToken] = useState<string | null>(() =>
    tokenFromFragment(location.hash),
  );
  const [state, setState] = useState<PageState>(token ? 'form' : 'missing_token');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<unknown>(null);

  // Scrub the token-bearing fragment from the address bar and history entry
  // as soon as the token has been captured (verification-page pattern).
  useEffect(() => {
    if (location.hash !== '') {
      navigate(location.pathname, { replace: true });
    }
  }, [location.hash, location.pathname, navigate]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!token) return;
    setError(null);
    if (newPassword !== confirmPassword) {
      setError(new Error('The passwords do not match.'));
      return;
    }
    setState('submitting');
    try {
      await api.post<PasswordRecoveryCompleteResponse>(
        '/v1/auth/password-recovery/complete',
        { token, newPassword },
        { authenticated: false },
      );
      // Single-use token: drop it (and the passwords) from memory for good.
      setToken(null);
      setNewPassword('');
      setConfirmPassword('');
      setState('success');
    } catch (caught) {
      const apiError = toApiError(caught);
      if (apiError.code === 'PASSWORD_RESET_TOKEN_EXPIRED') {
        setToken(null);
        setState('expired');
      } else if (apiError.code === 'PASSWORD_RESET_TOKEN_USED') {
        setToken(null);
        setState('used');
      } else if (apiError.code === 'PASSWORD_RESET_TOKEN_INVALID') {
        setToken(null);
        setState('invalid');
      } else {
        // Validation / rate-limit / transient failure: keep the token so the
        // user can correct the password and retry.
        setError(apiError);
        setState('form');
      }
    }
  }

  const requestNewLink = (
    <p className="muted" style={{ marginTop: '1rem' }}>
      <Link to="/auth/forgot-password">Request a new reset link</Link>
    </p>
  );

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <h1>Choose a new password</h1>
        {state === 'missing_token' && (
          <>
            <div className="banner banner-error" role="alert">
              This page needs the password reset link from your email. Open the
              link exactly as it appears in the message, or request a new one.
            </div>
            {requestNewLink}
          </>
        )}
        {state === 'success' && (
          <>
            <div className="banner banner-success" role="status">
              Your password has been reset. Sign in with your new password —
              all previous sessions have been signed out.
            </div>
            <p className="muted" style={{ marginTop: '1rem' }}>
              <Link to="/auth/login">Go to sign in</Link>
            </p>
          </>
        )}
        {state === 'invalid' && (
          <>
            <div className="banner banner-error" role="alert">
              This password reset link is not valid. Request a new one and use
              the newest email.
            </div>
            {requestNewLink}
          </>
        )}
        {state === 'expired' && (
          <>
            <div className="banner banner-error" role="alert">
              This password reset link has expired. Request a new one.
            </div>
            {requestNewLink}
          </>
        )}
        {state === 'used' && (
          <>
            <div className="banner banner-error" role="alert">
              This password reset link has already been used or was replaced by
              a newer one. If you still need to reset your password, request a
              new link.
            </div>
            {requestNewLink}
          </>
        )}
        {(state === 'form' || state === 'submitting') && (
          <>
            {error != null && <ErrorBanner error={error} />}
            <form onSubmit={handleSubmit}>
              <div className="field">
                <label htmlFor="newPassword">New password</label>
                <input
                  id="newPassword"
                  type="password"
                  className="input"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  minLength={MIN_PASSWORD_LENGTH}
                  required
                  autoFocus
                />
                <span className="muted" style={{ fontSize: '0.8rem' }}>
                  At least {MIN_PASSWORD_LENGTH} characters.
                </span>
              </div>
              <div className="field">
                <label htmlFor="confirmPassword">Confirm new password</label>
                <input
                  id="confirmPassword"
                  type="password"
                  className="input"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  minLength={MIN_PASSWORD_LENGTH}
                  required
                />
              </div>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={state === 'submitting'}
                style={{ width: '100%' }}
              >
                {state === 'submitting' ? 'Resetting…' : 'Reset password'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
