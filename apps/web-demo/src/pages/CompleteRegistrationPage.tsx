import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { toApiError } from '../api/errors';
import { useAuth } from '../auth/useAuth';

/**
 * Registration completion page (Sprint 18): the target of the emailed link
 * `/auth/complete-registration#token=…`.
 *
 * Token handling rules (identical to the verification and reset pages):
 *  - the token travels in the URL FRAGMENT, so the browser never sends it to
 *    the web server, a proxy, an access log, or a `Referer` header — it is
 *    NEVER copied into a query string or any API URL;
 *  - it is captured ONCE from the fragment into transient component memory —
 *    never localStorage, sessionStorage, or React context;
 *  - the fragment is immediately removed with a history replacement so the
 *    token does not linger in the address bar or history entry;
 *  - it is submitted to the backend exactly once, in the completion POST
 *    body, and is never rendered anywhere.
 *
 * A successful completion IS the account creation: the backend returns the
 * authenticated session, which is adopted and the user is taken into the app.
 * If the registration carried an invitation that can no longer be honored,
 * the account still exists — the page says so before continuing.
 */

type CompletionState =
  | 'missing_token'
  | 'completing'
  | 'success'
  | 'invitation_unavailable'
  | 'invalid'
  | 'expired'
  | 'used'
  | 'failed';

/** Extract `token` from a `#token=…` fragment ("" or "#..." forms). */
function tokenFromFragment(hash: string): string | null {
  return new URLSearchParams(hash.replace(/^#/, '')).get('token');
}

export function CompleteRegistrationPage() {
  const { status, completeRegistration } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  // Capture the token ONCE into transient component memory. The router hash
  // mirrors window.location.hash under BrowserRouter.
  const [token] = useState(() => tokenFromFragment(location.hash));
  const [state, setState] = useState<CompletionState>(
    token ? 'completing' : 'missing_token',
  );
  // StrictMode double-invokes effects; the token is single-use, so guard
  // against submitting it twice.
  const submitted = useRef(false);

  // Scrub the token-bearing fragment from the address bar and history entry
  // as soon as the token has been captured (verification-page pattern).
  useEffect(() => {
    if (location.hash !== '') {
      navigate(location.pathname, { replace: true });
    }
  }, [location.hash, location.pathname, navigate]);

  useEffect(() => {
    // Wait for the boot-time session restore to settle before completing:
    // completion ADOPTS a fresh session, and a still-in-flight (failing)
    // restore would otherwise race it and clobber the new authenticated state.
    if (status === 'restoring') return;
    if (!token || submitted.current) return;
    submitted.current = true;
    let cancelled = false;
    (async () => {
      try {
        const { invitationUnavailable } = await completeRegistration(token);
        if (cancelled) return;
        setState(invitationUnavailable ? 'invitation_unavailable' : 'success');
      } catch (caught) {
        if (cancelled) return;
        const error = toApiError(caught);
        if (error.code === 'REGISTRATION_TOKEN_EXPIRED') {
          setState('expired');
        } else if (error.code === 'REGISTRATION_TOKEN_USED') {
          setState('used');
        } else if (error.code === 'REGISTRATION_TOKEN_INVALID') {
          setState('invalid');
        } else {
          setState('failed');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status, token, completeRegistration]);

  // On success, move into the authenticated app. The invitation-unavailable
  // variant pauses on an explanation first (the account itself is ready).
  useEffect(() => {
    if (state === 'success') {
      navigate('/app/overview', { replace: true });
    }
  }, [state, navigate]);

  const registerAgain = (
    <p className="muted" style={{ marginTop: '1rem' }}>
      <Link to="/auth/register">Register again to receive a new link</Link>
    </p>
  );

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <h1>Finishing your registration</h1>
        {(state === 'completing' || state === 'success') && (
          <p className="muted" role="status">
            Confirming your email address and creating your account…
          </p>
        )}
        {state === 'invitation_unavailable' && (
          <>
            <div className="banner banner-success" role="status">
              Your account and personal workspace are ready, but the
              organization invitation you registered with is no longer
              available (it may have expired or been revoked). Ask for a new
              invitation to join that organization.
            </div>
            <p className="muted" style={{ marginTop: '1rem' }}>
              <Link to="/app/overview">Continue to your workspace</Link>
            </p>
          </>
        )}
        {state === 'missing_token' && (
          <>
            <div className="banner banner-error" role="alert">
              This page needs the registration link from your email. Open the
              link exactly as it appears in the message, or register again to
              receive a new one.
            </div>
            {registerAgain}
          </>
        )}
        {state === 'invalid' && (
          <>
            <div className="banner banner-error" role="alert">
              This registration link is not valid. Register again and use the
              newest email.
            </div>
            {registerAgain}
          </>
        )}
        {state === 'expired' && (
          <>
            <div className="banner banner-error" role="alert">
              This registration link has expired. Register again to receive a
              new one.
            </div>
            {registerAgain}
          </>
        )}
        {state === 'used' && (
          <>
            <div className="banner banner-error" role="alert">
              This registration link has already been used or was replaced by
              a newer one. If you completed registration earlier, simply sign
              in.
            </div>
            <p className="muted" style={{ marginTop: '1rem' }}>
              <Link to="/auth/login">Go to sign in</Link>
            </p>
            {registerAgain}
          </>
        )}
        {state === 'failed' && (
          <>
            <div className="banner banner-error" role="alert">
              Something went wrong while completing your registration. Try the
              link again in a moment.
            </div>
            {registerAgain}
          </>
        )}
      </div>
    </div>
  );
}
