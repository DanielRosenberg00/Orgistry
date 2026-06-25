import { useState } from 'react';
import {
  PLAN_CATALOG_LIST,
  type EntitlementValues,
  type PlanKey,
} from '@orgistry/contracts';
import {
  useChangeDemoPlan,
  useEntitlements,
  usePlan,
} from '../hooks/usePlan';
import { useEffectivePermissions } from '../hooks/useEffectivePermissions';
import { ErrorBanner } from '../components/ErrorBanner';
import { PermissionNote } from '../components/PermissionNote';
import { QueryBoundary } from '../components/QueryStates';

/**
 * Plan & entitlements. Shows the current internal demo plan, the resolved
 * quota/feature entitlements, and a demo plan switcher (when permitted).
 *
 * Free / Pro / Business are INTERNAL DEMO PLANS — there is no billing, Stripe,
 * checkout, or subscription anywhere. A plan change only re-resolves the
 * organization's entitlements.
 */
export function PlanPage() {
  const plan = usePlan();
  const entitlements = useEntitlements();
  const changePlan = useChangeDemoPlan();
  const permissions = useEffectivePermissions();

  const [target, setTarget] = useState<PlanKey>('free');
  const [changeError, setChangeError] = useState<unknown>(null);
  const [changedTo, setChangedTo] = useState<string | null>(null);

  const canChange = permissions.has('plan.change_demo');

  function handleChange(event: React.FormEvent) {
    event.preventDefault();
    setChangeError(null);
    setChangedTo(null);
    changePlan.mutate(
      { planKey: target },
      {
        onSuccess: (result) => setChangedTo(result.plan.name),
        onError: setChangeError,
      },
    );
  }

  return (
    <div>
      <h1 className="page-title">Plan &amp; entitlements</h1>
      <p className="page-intro">
        Free, Pro, and Business are internal demo plans — not billing or
        subscriptions.
      </p>

      <div className="card">
        <h2>Current plan</h2>
        <QueryBoundary isLoading={plan.isLoading} error={plan.error}>
          {plan.data && (
            <p>
              <strong>{plan.data.plan.name}</strong> — {plan.data.plan.description}
            </p>
          )}
        </QueryBoundary>
      </div>

      <div className="card">
        <h2>Entitlements &amp; quotas</h2>
        <QueryBoundary isLoading={entitlements.isLoading} error={entitlements.error}>
          {entitlements.data && (
            <EntitlementsTable values={entitlements.data.entitlements} />
          )}
        </QueryBoundary>
      </div>

      <div className="card">
        <h2>Change demo plan</h2>
        {changeError != null && <ErrorBanner error={changeError} />}
        {changedTo && (
          <div className="banner banner-success">
            Plan changed to {changedTo}. Entitlements have been re-resolved.
          </div>
        )}
        <form onSubmit={handleChange} className="row" style={{ alignItems: 'end' }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="plan-select">Target plan</label>
            <select
              id="plan-select"
              className="select"
              value={target}
              onChange={(event) => setTarget(event.target.value as PlanKey)}
              disabled={!canChange}
            >
              {PLAN_CATALOG_LIST.map((entry) => (
                <option key={entry.key} value={entry.key}>
                  {entry.name}
                </option>
              ))}
            </select>
          </div>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={!canChange || changePlan.isPending}
          >
            {changePlan.isPending ? 'Applying…' : 'Apply demo plan'}
          </button>
        </form>
        {!canChange && (
          <PermissionNote>
            Only an Owner (with <code>plan.change_demo</code>) can change the demo
            plan.
          </PermissionNote>
        )}
      </div>
    </div>
  );
}

function EntitlementsTable({ values }: { values: EntitlementValues }) {
  return (
    <table className="table">
      <tbody>
        <Row label="Max members" value={String(values.max_members)} />
        <Row label="Max projects" value={String(values.max_projects)} />
        <Row label="Max API keys" value={String(values.max_api_keys)} />
        <Row label="API keys access" value={yesNo(values.api_keys_access)} />
        <Row label="Audit log access" value={yesNo(values.audit_log_access)} />
        <Row
          label="Audit retention (days)"
          value={String(values.audit_retention_days)}
        />
      </tbody>
    </table>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <tr>
      <td>{label}</td>
      <td>
        <code>{value}</code>
      </td>
    </tr>
  );
}

function yesNo(value: boolean): string {
  return value ? 'Enabled' : 'Disabled';
}
