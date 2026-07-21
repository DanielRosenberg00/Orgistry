import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import type {
  InvitationAcceptResponse,
  InvitationInspectResponse,
  PublicInvitation,
} from '@orgistry/contracts';
import { api } from '../api/client';
import { toApiError } from '../api/errors';
import { useAuth } from '../auth/useAuth';
import { ErrorBanner } from '../components/ErrorBanner';

/**
 * Invitation landing page: the target of the emailed link
 * `/invitations/accept?token=…` (invitation links carry the token as a query
 * parameter — the established invitation-email convention, unlike the
 * fragment-borne auth tokens).
 *
 * Raw-token handling rules:
 *  - the token is captured ONCE from the query string into transient
 *    component memory — never localStorage, sessionStorage, or React
 *    context — and the token-bearing query is immediately scrubbed from the
 *    address bar and history entry;
 *  - it is sent ONLY in POST bodies (`/v1/invitations/inspect`, and either
 *    `/v1/invitations/accept` or, via router state handed to the register
 *    page, `/v1/auth/register`) and is never rendered or logged;
 *  - the dedicated INSPECT endpoint is the invitation-state feedback channel:
 *    it returns safe public context (organization name, invited email, role)
 *    for an acceptable invitation and precise lifecycle errors otherwise.
 *
 * Signed-in visitors accept directly (existing-user flow, no new session).
 * Signed-out visitors continue to registration carrying the token in
 * TRANSIENT router state (scrubbed again by the register page), which keeps
 * the verification-first flow: generic acceptance, then the emailed
 * completion link creates the account and joins the organization.
 */

type PageState =
  | 'missing_token'
  | 'inspecting'
  | 'ready'
  | 'accepting'
  | 'accepted'
  | 'invalid'
  | 'expired'
  | 'revoked'
  | 'already_accepted'
  | 'failed';

export function InvitationPage() {
  const { status, user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  // Capture the token ONCE into transient component memory.
  const [token, setToken] = useState<string | null>(() =>
    new URLSearchParams(location.search).get('token'),
  );
  const [state, setState] = useState<PageState>(
    token ? 'inspecting' : 'missing_token',
  );
  const [invitation, setInvitation] = useState<PublicInvitation | null>(null);
  const [error, setError] = useState<unknown>(null);
  // StrictMode double-invokes effects; inspect once per captured token.
  const inspected = useRef(false);

  // Scrub the token-bearing query from the address bar and history entry as
  // soon as the token has been captured (same posture as the fragment pages).
  useEffect(() => {
    if (location.search !== '') {
      navigate(location.pathname, { replace: true });
    }
  }, [location.search, location.pathname, navigate]);

  useEffect(() => {
    if (!token || inspected.current) return;
    inspected.current = true;
    let cancelled = false;
    (async () => {
      try {
        const { invitation: inspectedInvitation } =
          await api.post<InvitationInspectResponse>(
            '/v1/invitations/inspect',
            { token },
            { authenticated: false },
          );
        if (cancelled) return;
        setInvitation(inspectedInvitation);
        setState('ready');
      } catch (caught) {
        if (cancelled) return;
        const apiError = toApiError(caught);
        if (apiError.code === 'INVITATION_EXPIRED') {
          setState('expired');
        } else if (apiError.code === 'INVITATION_REVOKED') {
          setState('revoked');
        } else if (apiError.code === 'INVITATION_ALREADY_ACCEPTED') {
          setState('already_accepted');
        } else if (apiError.code === 'INVITATION_INVALID') {
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

  // Existing-user path: accept directly (creates the membership, no session).
  async function handleAccept() {
    if (!token) return;
    setError(null);
    setState('accepting');
    try {
      await api.post<InvitationAcceptResponse>('/v1/invitations/accept', {
        token,
      });
      // Single-use token: drop it from memory for good.
      setToken(null);
      setState('accepted');
    } catch (caught) {
      setError(toApiError(caught));
      setState('ready');
    }
  }

  // New-user path: continue to registration. The token travels ONLY in
  // transient router state (the register page captures and scrubs it) along
  // with the safe display context the inspect endpoint already disclosed.
  function handleRegister() {
    if (!token || !invitation) return;
    const invitationState = {
      token,
      organizationName: invitation.organizationName,
      invitedEmail: invitation.invitedEmail,
    };
    setToken(null);
    navigate('/auth/register', { state: { invitation: invitationState } });
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <h1>Organization invitation</h1>
        {state === 'inspecting' && (
          <p className="muted" role="status">
            Checking your invitation…
          </p>
        )}
        {state === 'missing_token' && (
          <div className="banner banner-error" role="alert">
            This page needs the invitation link from your email. Open the link
            exactly as it appears in the message.
          </div>
        )}
        {state === 'invalid' && (
          <div className="banner banner-error" role="alert">
            This invitation link is not valid. Ask the organization to send a
            new invitation.
          </div>
        )}
        {state === 'expired' && (
          <div className="banner banner-error" role="alert">
            This invitation has expired. Ask the organization to send a new
            invitation.
          </div>
        )}
        {state === 'revoked' && (
          <div className="banner banner-error" role="alert">
            This invitation has been revoked and can no longer be used.
          </div>
        )}
        {state === 'already_accepted' && (
          <div className="banner banner-error" role="alert">
            This invitation has already been accepted. If that was you, simply
            sign in.
          </div>
        )}
        {state === 'failed' && (
          <div className="banner banner-error" role="alert">
            Something went wrong while checking the invitation. Try the link
            again in a moment.
          </div>
        )}
        {state === 'accepted' && (
          <>
            <div className="banner banner-success" role="status">
              Invitation accepted — you are now a member of the organization.
            </div>
            <p className="muted" style={{ marginTop: '1rem' }}>
              <Link to="/app/overview">Continue to the app</Link>
            </p>
          </>
        )}
        {(state === 'ready' || state === 'accepting') && invitation && (
          <>
            {error != null && <ErrorBanner error={error} />}
            <p>
              You have been invited to join{' '}
              <strong>{invitation.organizationName}</strong> as{' '}
              <strong>{invitation.role.name}</strong>.
            </p>
            <p className="muted">
              This invitation was issued to{' '}
              <strong>{invitation.invitedEmail}</strong>.
            </p>
            {status === 'authenticated' ? (
              <>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleAccept}
                  disabled={state === 'accepting'}
                  style={{ width: '100%' }}
                >
                  {state === 'accepting'
                    ? 'Accepting…'
                    : 'Accept invitation'}
                </button>
                {user &&
                  user.email.toLowerCase() !==
                    invitation.invitedEmail.toLowerCase() && (
                    <p className="muted" style={{ marginTop: '0.5rem' }}>
                      You are signed in as {user.email}; the invitation can
                      only be accepted by the invited address.
                    </p>
                  )}
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleRegister}
                  style={{ width: '100%' }}
                >
                  Create an account to join
                </button>
                <p className="muted" style={{ marginTop: '1rem' }}>
                  Already have an Orgistry account for this address?{' '}
                  <Link to="/auth/login">Sign in</Link>, then open the
                  invitation link from your email again to accept it.
                </p>
              </>
            )}
          </>
        )}
        {state !== 'ready' && state !== 'accepting' && state !== 'inspecting' && (
          <p className="muted" style={{ marginTop: '1rem' }}>
            <Link to="/auth/login">Go to sign in</Link>
          </p>
        )}
      </div>
    </div>
  );
}
