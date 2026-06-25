import { useState } from 'react';
import { useOrganization } from '../organization/useOrganization';
import { ErrorBanner } from './ErrorBanner';

/**
 * Organization switcher + team-organization creation.
 *
 * Switching changes only CLIENT context (which org-scoped API calls the UI
 * makes). The backend re-resolves membership on every request, so the dropdown
 * can never grant access the user does not have.
 */
export function OrganizationSwitcher() {
  const {
    organizations,
    selectedOrganizationId,
    selectOrganization,
    createTeamOrganization,
  } = useOrganization();

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      await createTeamOrganization(name.trim());
      setName('');
      setCreating(false);
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="row">
      <label className="muted" htmlFor="org-switcher">
        Organization
      </label>
      <select
        id="org-switcher"
        className="select"
        value={selectedOrganizationId ?? ''}
        onChange={(event) => selectOrganization(event.target.value)}
      >
        {organizations.map(({ organization }) => (
          <option key={organization.id} value={organization.id}>
            {organization.name}
          </option>
        ))}
      </select>
      <button
        className="btn btn-sm"
        onClick={() => setCreating((open) => !open)}
        aria-expanded={creating}
      >
        New team
      </button>

      {creating && (
        <form onSubmit={handleCreate} className="card" style={popoverStyle}>
          {error != null && <ErrorBanner error={error} />}
          <div className="field">
            <label htmlFor="new-org-name">Team organization name</label>
            <input
              id="new-org-name"
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              autoFocus
            />
          </div>
          <button
            type="submit"
            className="btn btn-primary btn-sm"
            disabled={pending || name.trim().length === 0}
          >
            {pending ? 'Creating…' : 'Create'}
          </button>
        </form>
      )}
    </div>
  );
}

const popoverStyle: React.CSSProperties = {
  position: 'absolute',
  top: '3.5rem',
  right: '1.5rem',
  width: '320px',
  zIndex: 10,
  marginBottom: 0,
};
