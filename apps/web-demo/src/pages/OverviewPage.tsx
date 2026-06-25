import { Link } from 'react-router-dom';
import { useOrganization } from '../organization/useOrganization';
import { useEffectivePermissions } from '../hooks/useEffectivePermissions';
import { usePlan } from '../hooks/usePlan';

/**
 * Organization overview — the default landing surface for the selected org.
 *
 * A summary, not an analytics dashboard: organization identity, the caller's
 * role, an effective-permissions count, the current plan, and quick links into
 * the admin surfaces.
 */
export function OverviewPage() {
  const { selected } = useOrganization();
  const permissions = useEffectivePermissions();
  const plan = usePlan();

  // `selected` is guaranteed by the app shell, which only renders org-scoped
  // pages once an organization is selected.
  const organization = selected!.organization;
  const membership = selected!.membership;

  return (
    <div>
      <h1 className="page-title">{organization.name}</h1>
      <p className="page-intro">Organization overview.</p>

      <div className="card">
        <h2>Organization</h2>
        <div className="grid-2">
          <Fact label="Name" value={organization.name} />
          <Fact label="Type" value={organization.type} />
          <Fact label="Status" value={organization.status} />
          <Fact label="Your role" value={membership.role.name} />
        </div>
      </div>

      <div className="card">
        <div className="spread">
          <h2 style={{ margin: 0 }}>Your access</h2>
          <Link to="/app/members">Manage members →</Link>
        </div>
        <p className="muted">
          {permissions.query.isLoading
            ? 'Resolving effective permissions…'
            : `You hold ${permissions.permissions.length} effective permission(s) in this organization, derived from your ${permissions.role?.name ?? membership.role.name} role.`}
        </p>
        <p className="muted" style={{ fontSize: '0.82rem' }}>
          Permissions shown here drive UX hints only. The backend remains
          authoritative for every authorization decision.
        </p>
      </div>

      <div className="card">
        <div className="spread">
          <h2 style={{ margin: 0 }}>Plan</h2>
          <Link to="/app/plan">Plan &amp; entitlements →</Link>
        </div>
        <p className="muted">
          {plan.isLoading
            ? 'Loading plan…'
            : plan.data
              ? `Current plan: ${plan.data.plan.name}. Internal demo plan — not a billing subscription.`
              : 'Plan unavailable.'}
        </p>
      </div>

      <div className="card">
        <h2>Admin surfaces</h2>
        <div className="grid-2">
          <Link to="/app/members">Members</Link>
          <Link to="/app/invitations">Invitations</Link>
          <Link to="/app/projects">Projects</Link>
          <Link to="/app/api-keys">API keys</Link>
          <Link to="/app/audit">Audit log</Link>
        </div>
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="muted" style={{ fontSize: '0.8rem' }}>
        {label}
      </div>
      <div>{value}</div>
    </div>
  );
}
