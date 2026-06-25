import { useState } from 'react';
import { ROLE_KEY_ORDER, type RoleKey } from '@orgistry/contracts';
import {
  useCreateInvitation,
  useInvitations,
  useRevokeInvitation,
} from '../hooks/useInvitations';
import { useEffectivePermissions } from '../hooks/useEffectivePermissions';
import { ErrorBanner } from '../components/ErrorBanner';
import { PermissionNote } from '../components/PermissionNote';
import {
  EmptyState,
  LoadMore,
  QueryBoundary,
} from '../components/QueryStates';
import { formatDate } from '../lib/format';
import { MAILPIT_URL } from '../config';

/**
 * Invitation administration: list, create, and revoke organization invitations.
 *
 * The raw invitation token is NEVER shown here — it is delivered out-of-band by
 * email. In local development that email lands in Mailpit, linked below. Quota
 * (`max_members`) and duplicate-pending conflicts are surfaced from the backend
 * error verbatim.
 */
export function InvitationsPage() {
  const { query, items } = useInvitations();
  const permissions = useEffectivePermissions();
  const createInvitation = useCreateInvitation();
  const revokeInvitation = useRevokeInvitation();

  const [email, setEmail] = useState('');
  const [role, setRole] = useState<RoleKey>('member');
  const [formError, setFormError] = useState<unknown>(null);
  const [actionError, setActionError] = useState<unknown>(null);

  const canCreate = permissions.has('invitations.create');
  const canRevoke = permissions.has('invitations.revoke');

  function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    setFormError(null);
    createInvitation.mutate(
      { email: email.trim(), role },
      {
        onSuccess: () => setEmail(''),
        onError: setFormError,
      },
    );
  }

  function handleRevoke(invitationId: string) {
    setActionError(null);
    revokeInvitation.mutate({ invitationId }, { onError: setActionError });
  }

  return (
    <div>
      <h1 className="page-title">Invitations</h1>
      <p className="page-intro">Invite people to join this organization.</p>

      <div className="banner banner-info">
        Invitation emails (and their raw tokens) are delivered out-of-band. In
        local development, open <a href={MAILPIT_URL}>Mailpit</a> to retrieve the
        invite link. The admin UI never displays raw invitation tokens.
      </div>

      <div className="card">
        <h2>Create invitation</h2>
        {formError != null && <ErrorBanner error={formError} />}
        <form onSubmit={handleCreate} className="row" style={{ alignItems: 'end' }}>
          <div className="field" style={{ flex: 1, marginBottom: 0 }}>
            <label htmlFor="invite-email">Email</label>
            <input
              id="invite-email"
              type="email"
              className="input"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              disabled={!canCreate}
            />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="invite-role">Role</label>
            <select
              id="invite-role"
              className="select"
              value={role}
              onChange={(event) => setRole(event.target.value as RoleKey)}
              disabled={!canCreate}
            >
              {ROLE_KEY_ORDER.map((roleKey) => (
                <option key={roleKey} value={roleKey}>
                  {roleKey}
                </option>
              ))}
            </select>
          </div>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={!canCreate || createInvitation.isPending}
          >
            {createInvitation.isPending ? 'Sending…' : 'Send invitation'}
          </button>
        </form>
        {!canCreate && (
          <PermissionNote>
            You do not have permission to create invitations in this organization.
          </PermissionNote>
        )}
      </div>

      <div className="card">
        <h2>Pending &amp; past invitations</h2>
        {actionError != null && <ErrorBanner error={actionError} />}
        <QueryBoundary isLoading={query.isLoading} error={query.error}>
          {items.length === 0 ? (
            <EmptyState>No invitations yet.</EmptyState>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Expires</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {items.map((invitation) => (
                  <tr key={invitation.id}>
                    <td>{invitation.invitedEmail}</td>
                    <td>{invitation.role.name}</td>
                    <td>
                      <span
                        className={
                          invitation.status === 'pending'
                            ? 'badge badge-active'
                            : 'badge'
                        }
                      >
                        {invitation.status}
                      </span>
                    </td>
                    <td className="muted">{formatDate(invitation.expiresAt)}</td>
                    <td>
                      {invitation.status === 'pending' && (
                        <button
                          className="btn btn-sm btn-danger"
                          disabled={!canRevoke || revokeInvitation.isPending}
                          onClick={() => handleRevoke(invitation.id)}
                        >
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <LoadMore
            hasNextPage={query.hasNextPage}
            isFetchingNextPage={query.isFetchingNextPage}
            onClick={() => query.fetchNextPage()}
          />
        </QueryBoundary>
      </div>
    </div>
  );
}
