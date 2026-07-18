import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { toApiError } from '../api/errors';
import { useAuth } from '../auth/useAuth';

/**
 * Email-verification completion page (Sprint 16): the target of the emailed
 * link `/auth/verify-email#token=…`.
 *
 * Token handling rules (mirrors the backend security model):
 *  - the token travels in the URL FRAGMENT, so the browser never sends it to
 *    the web server, a proxy, an access log, or a `Referer` header — it is
 *    NEVER copied into a query string;
 *  - it is captured ONCE from the fragment into transient component memory —
 *    never localStorage, sessionStorage, or React context;
 *  - the fragment is immediately removed with a history replacement so the
 *    token does not linger in the address bar or history entry;
 *  - it is submitted to the backend exactly once, in a POST body (never a URL
 *    path), and is never rendered.
 *
 * The page works signed-in or signed-out (completion is public — possession
 * of the link is the proof). Every displayed state is derived from the
 * backend's response; after success the cached current user is refreshed so
 * the unverified banner disappears without a reload.
 */

type CompletionState =
  | 'missing_token'
  | 'verifying'
  | 'success'
  | 'invalid'
  | 'expired'
  | 'used'
  | 'failed';

/** Extract `token` from a `#token=…` fragment ("" or "#..." forms). */
function tokenFromFragment(hash: string): string | null {
  return new URLSearchParams(hash.replace(/^#/, '')).get('token');
}

export function VerifyEmailPage() {
  const { status, refreshUser } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  // Capture the token ONCE into transient component memory. The router hash
  // mirrors window.location.hash under BrowserRouter.
  const [token] = useState(() => tokenFromFragment(location.hash));
  const [state, setState] = useState<CompletionState>(
    token ? 'verifying' : 'missing_token',
  );
  // StrictMode double-invokes effects; the token is single-use, so guard
  // against submitting it twice.
  const submitted = useRef(false);

  // Scrub the token-bearing fragment from the address bar and history entry
  // as soon as the token has been captured. A replace navigation performs
  // `history.replaceState` under BrowserRouter, so the fragment never
  // survives in browser history.
  useEffect(() => {
    if (location.hash !== '') {
      navigate(location.pathname, { replace: true });
    }
  }, [location.hash, location.pathname, navigate]);

  useEffect(() => {
    if (!token || submitted.current) return;
    submitted.current = true;
    let cancelled = false;
    (async () => {
      try {
        await api.post(
          '/v1/auth/email-verification/complete',
          { token },
          { authenticated: false },
        );
        if (cancelled) return;
        setState('success');
      } catch (caught) {
        if (cancelled) return;
        const error = toApiError(caught);
        if (error.code === 'EMAIL_VERIFICATION_TOKEN_EXPIRED') {
          setState('expired');
        } else if (error.code === 'EMAIL_VERIFICATION_TOKEN_USED') {
          setState('used');
        } else if (error.code === 'EMAIL_VERIFICATION_TOKEN_INVALID') {
          setState('invalid');
        } else {
          setState('failed');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // After success, adopt the backend's new verification state into the cached
  // current user. Waits for the boot-time session restore to settle (the page
  // is opened from an email link, so restore may still be in flight) and runs
  // once; signed-out visitors have no cached user to refresh.
  const refreshed = useRef(false);
  useEffect(() => {
    if (state === 'success' && status === 'authenticated' && !refreshed.current) {
      refreshed.current = true;
      void refreshUser();
    }
  }, [state, status, refreshUser]);

  const continueTarget = status === 'authenticated' ? '/app/overview' : '/auth/login';
  const continueLabel =
    status === 'authenticated' ? 'Back to the app' : 'Sign in';

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <h1>Email verification</h1>
        {state === 'verifying' && (
          <p className="muted" role="status">
            Verifying your email address…
          </p>
        )}
        {state === 'success' && (
          <div className="banner banner-success" role="status">
            Your email address is verified.
          </div>
        )}
        {state === 'missing_token' && (
          <div className="banner banner-error" role="alert">
            This page needs the verification link from your email. Open the
            link exactly as it appears in the message, or request a new one
            from the app.
          </div>
        )}
        {state === 'invalid' && (
          <div className="banner banner-error" role="alert">
            This verification link is not valid. Request a new verification
            email from the app and use the newest link.
          </div>
        )}
        {state === 'expired' && (
          <div className="banner banner-error" role="alert">
            This verification link has expired. Request a new verification
            email from the app.
          </div>
        )}
        {state === 'used' && (
          <div className="banner banner-error" role="alert">
            This verification link has already been used or was replaced by a
            newer one. If your address is still unverified, request a new
            email from the app.
          </div>
        )}
        {state === 'failed' && (
          <div className="banner banner-error" role="alert">
            Something went wrong while verifying. Try the link again in a
            moment.
          </div>
        )}
        {state !== 'verifying' && (
          <p className="muted" style={{ marginTop: '1rem' }}>
            <Link to={continueTarget}>{continueLabel}</Link>
          </p>
        )}
      </div>
    </div>
  );
}
