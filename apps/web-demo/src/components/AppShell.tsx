import { NavLink, Outlet } from 'react-router-dom';
import { useState } from 'react';
import { useAuth } from '../auth/useAuth';
import { useOrganization } from '../organization/useOrganization';
import { OrganizationSwitcher } from './OrganizationSwitcher';
import { ErrorBanner } from './ErrorBanner';
import { LoadingState } from './QueryStates';

/** Primary navigation targets, in display order. */
const NAV_ITEMS = [
  { to: '/app/overview', label: 'Overview' },
  { to: '/app/members', label: 'Members' },
  { to: '/app/invitations', label: 'Invitations' },
  { to: '/app/projects', label: 'Projects' },
  { to: '/app/plan', label: 'Plan & entitlements' },
  { to: '/app/api-keys', label: 'API keys' },
  { to: '/app/audit', label: 'Audit log' },
];

/**
 * Authenticated application shell: sidebar navigation, a top bar showing the
 * current user and selected organization (with the switcher and logout), and the
 * routed page content.
 *
 * Org-scoped pages render only once an organization is selected, so the shell
 * resolves the organization list first and shows the appropriate loading /
 * error / no-organization surface before handing off to the page `Outlet`.
 */
export function AppShell() {
  const { user, logout } = useAuth();
  const { selected, isLoading, error } = useOrganization();
  const [loggingOut, setLoggingOut] = useState(false);

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await logout();
    } finally {
      setLoggingOut(false);
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">Orgistry</div>
        <nav className="nav">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                isActive ? 'nav-link active' : 'nav-link'
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <p className="muted" style={{ fontSize: '0.78rem', marginTop: 'auto' }}>
          Thin official consumer of the Orgistry API. The backend remains
          authoritative for all authorization, entitlement, quota, and
          tenant-isolation decisions.
        </p>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="topbar-meta">
            {selected ? (
              <span>
                <strong>{selected.organization.name}</strong>{' '}
                <span className="badge">{selected.organization.type}</span>{' '}
                <span className="badge">{selected.organization.status}</span>
              </span>
            ) : (
              <span className="muted">No organization selected</span>
            )}
          </div>
          <div className="topbar-meta">
            <OrganizationSwitcher />
            <span>{user?.displayName}</span>
            <button
              className="btn btn-sm"
              onClick={handleLogout}
              disabled={loggingOut}
            >
              {loggingOut ? 'Signing out…' : 'Log out'}
            </button>
          </div>
        </header>

        <main className="content">
          <ShellBody isLoading={isLoading} error={error} hasSelection={!!selected}>
            <Outlet />
          </ShellBody>
        </main>
      </div>
    </div>
  );
}

/**
 * Resolve the organization context before rendering an org-scoped page. When the
 * user belongs to no organization, point them at the switcher's "New team"
 * action rather than rendering a page that has no tenant to talk to.
 */
function ShellBody({
  isLoading,
  error,
  hasSelection,
  children,
}: {
  isLoading: boolean;
  error: unknown;
  hasSelection: boolean;
  children: React.ReactNode;
}) {
  if (isLoading) {
    return <LoadingState label="Loading organizations…" />;
  }
  if (error) {
    return <ErrorBanner error={error} />;
  }
  if (!hasSelection) {
    return (
      <div className="card">
        <h2>No organization yet</h2>
        <p className="muted">
          You do not belong to any organization. Create a team organization with
          the <strong>New team</strong> button above to get started.
        </p>
      </div>
    );
  }
  return <>{children}</>;
}
