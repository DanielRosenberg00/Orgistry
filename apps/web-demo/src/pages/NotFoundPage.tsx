import { Link } from 'react-router-dom';

/** Fallback page for unknown routes. */
export function NotFoundPage() {
  return (
    <div className="auth-screen">
      <div className="auth-card">
        <h1>Not found</h1>
        <p className="muted">No page is registered for this path.</p>
        <p>
          <Link to="/app">Go to the app</Link>
        </p>
      </div>
    </div>
  );
}
