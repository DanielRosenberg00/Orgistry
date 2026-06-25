import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/useAuth';
import { LoadingState } from './QueryStates';

/**
 * Gate for the authenticated `/app` area.
 *
 *  - while the boot-time session restore is in flight, render a loading state
 *    (so a logged-in user is never bounced to login on a hard refresh);
 *  - once resolved, an unauthenticated user is redirected to the login screen;
 *  - an authenticated user sees the nested routes.
 *
 * This is a routing convenience. The backend independently authenticates every
 * request via the access token, so it — not this guard — is the real boundary.
 */
export function ProtectedRoute() {
  const { status } = useAuth();

  if (status === 'restoring') {
    return <LoadingState label="Restoring session…" />;
  }
  if (status === 'unauthenticated') {
    return <Navigate to="/auth/login" replace />;
  }
  return <Outlet />;
}
