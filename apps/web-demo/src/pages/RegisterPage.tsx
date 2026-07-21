import { useEffect, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { MIN_PASSWORD_LENGTH } from '@orgistry/contracts';
import { useAuth } from '../auth/useAuth';
import { ErrorBanner } from '../components/ErrorBanner';

/**
 * Account registration (Sprint 18, verification-first).
 *
 * Submitting the form only REQUESTS a registration: the backend answers a
 * generic acceptance whether or not the address (or a carried invitation) can
 * be used, and the account is created solely by the emailed completion link.
 * The page therefore shows ONE generic check-email state after submission —
 * the copy deliberately does not (and cannot) reveal whether an account
 * already exists or whether an invitation was valid — and never treats
 * submission as a sign-in.
 *
 * Invitation-aware registration: the invitation landing page hands over
 * TRANSIENT router state `{ invitation: { token, organizationName,
 * invitedEmail } }`. The raw invitation token is captured ONCE into component
 * memory, the history state is immediately scrubbed (so the token survives in
 * no history entry), it is sent ONLY in the registration request body, and it
 * is dropped from memory as soon as the request is accepted. Only the safe
 * display context the invitation-inspect endpoint already disclosed
 * (organization name, invited email) is kept for rendering — never the token.
 */

interface InvitationContext {
  token: string;
  organizationName: string;
  invitedEmail: string;
}

/** Safe subset of the invitation context that may outlive the request. */
interface InvitationDisplayContext {
  organizationName: string;
}

function invitationFromRouterState(state: unknown): InvitationContext | null {
  if (typeof state !== 'object' || state === null) return null;
  const invitation = (state as { invitation?: unknown }).invitation;
  if (typeof invitation !== 'object' || invitation === null) return null;
  const { token, organizationName, invitedEmail } = invitation as Record<
    string,
    unknown
  >;
  if (
    typeof token !== 'string' ||
    typeof organizationName !== 'string' ||
    typeof invitedEmail !== 'string'
  ) {
    return null;
  }
  return { token, organizationName, invitedEmail };
}

export function RegisterPage() {
  const { status, register } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  // Capture invitation context ONCE into transient component memory.
  const [invitation, setInvitation] = useState<InvitationContext | null>(() =>
    invitationFromRouterState(location.state),
  );
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState(() => invitation?.invitedEmail ?? '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const [submitted, setSubmitted] = useState<{
    email: string;
    invitation: InvitationDisplayContext | null;
  } | null>(null);

  // Scrub the token-bearing router state from the history entry as soon as
  // the invitation context has been captured (fragment-page posture: the raw
  // token must not survive in browser history).
  useEffect(() => {
    if (location.state != null) {
      navigate(location.pathname, { replace: true, state: null });
    }
  }, [location.state, location.pathname, navigate]);

  if (status === 'authenticated') {
    return <Navigate to="/app/overview" replace />;
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      await register({
        displayName: displayName.trim(),
        email: email.trim(),
        password,
        ...(invitation ? { invitationToken: invitation.token } : {}),
      });
      // The password and the raw invitation token are no longer needed once
      // the request is accepted: drop both from memory for good. Only the
      // safe display context (organization name) survives for the copy below.
      setPassword('');
      setSubmitted({
        email: email.trim(),
        invitation: invitation
          ? { organizationName: invitation.organizationName }
          : null,
      });
      setInvitation(null);
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(false);
    }
  }

  if (submitted !== null) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <h1>Check your email</h1>
          <div className="banner banner-success" role="status">
            Thanks — your registration request has been received.
          </div>
          <p className="muted" style={{ marginTop: '1rem' }}>
            If <strong>{submitted.email}</strong> can be used for a new
            Orgistry account, a message with a link to finish creating it is on
            its way. Open that link to choose this device and continue — the
            link expires after a while and can be used once.
          </p>
          {submitted.invitation && (
            <p className="muted">
              Finishing registration through that link will also apply your
              invitation to{' '}
              <strong>{submitted.invitation.organizationName}</strong>, as long
              as the invitation is still available then.
            </p>
          )}
          <p className="muted">
            Nothing arrived after a few minutes? Check your spam folder, or
            submit the form again to receive a fresh link (only the newest link
            works).
          </p>
          <p className="muted" style={{ marginTop: '1rem' }}>
            Already have an account? <Link to="/auth/login">Sign in</Link> or{' '}
            <Link to="/auth/forgot-password">reset your password</Link>.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <h1>Create your Orgistry account</h1>
        {invitation && (
          <div className="banner banner-success" role="status">
            You are registering with an invitation to join{' '}
            <strong>{invitation.organizationName}</strong>. Use the invited
            address ({invitation.invitedEmail}) so the invitation can be
            applied.
          </div>
        )}
        {error != null && <ErrorBanner error={error} />}
        <form onSubmit={handleSubmit}>
          <div className="field">
            <label htmlFor="displayName">Display name</label>
            <input
              id="displayName"
              className="input"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              required
              autoFocus
            />
          </div>
          <div className="field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              className="input"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              className="input"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              minLength={MIN_PASSWORD_LENGTH}
              required
            />
            <span className="muted" style={{ fontSize: '0.8rem' }}>
              At least {MIN_PASSWORD_LENGTH} characters.
            </span>
          </div>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={pending}
            style={{ width: '100%' }}
          >
            {pending ? 'Sending…' : 'Continue with email'}
          </button>
        </form>
        <p className="muted" style={{ marginTop: '1rem' }}>
          We’ll email you a link to confirm your address and finish creating
          the account.
        </p>
        <p className="muted">
          Already have an account? <Link to="/auth/login">Sign in</Link>.
        </p>
      </div>
    </div>
  );
}
