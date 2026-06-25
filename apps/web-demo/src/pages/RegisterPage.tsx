import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { MIN_PASSWORD_LENGTH } from '@orgistry/contracts';
import { useAuth } from '../auth/useAuth';
import { ErrorBanner } from '../components/ErrorBanner';

/**
 * Account registration. On success the backend provisions a personal
 * organization and signs the user in, so we land them straight in the app.
 */
export function RegisterPage() {
  const { status, register } = useAuth();
  const navigate = useNavigate();
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);

  if (status === 'authenticated') {
    return <Navigate to="/app/overview" replace />;
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      await register({ displayName: displayName.trim(), email: email.trim(), password });
      navigate('/app/overview', { replace: true });
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <h1>Create your Orgistry account</h1>
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
            {pending ? 'Creating account…' : 'Create account'}
          </button>
        </form>
        <p className="muted" style={{ marginTop: '1rem' }}>
          Already have an account? <Link to="/auth/login">Sign in</Link>.
        </p>
      </div>
    </div>
  );
}
