import { useState } from 'react';
import { ROLE_KEY_ORDER, type Member, type RoleKey } from '@orgistry/contracts';
import {
  useChangeMemberRole,
  useMembers,
  useRemoveMember,
} from '../hooks/useMembers';
import { useEffectivePermissions } from '../hooks/useEffectivePermissions';
import { ErrorBanner } from '../components/ErrorBanner';
import { PermissionNote } from '../components/PermissionNote';
import {
  EmptyState,
  LoadMore,
  QueryBoundary,
} from '../components/QueryStates';
import { formatDate } from '../lib/format';

/**
 * Member management: list members, change roles, remove members.
 *
 * Permission checks (`members.change_role`, `members.remove`) only disable
 * controls as a hint. Last Owner protection and authorization are enforced by
 * the backend; the page renders whatever error it returns (LAST_OWNER_REQUIRED,
 * FORBIDDEN, …) without trying to predict it.
 */
export function MembersPage() {
  const { query, items } = useMembers();
  const permissions = useEffectivePermissions();
  const changeRole = useChangeMemberRole();
  const removeMember = useRemoveMember();
  const [actionError, setActionError] = useState<unknown>(null);

  const canChangeRole = permissions.has('members.change_role');
  const canRemove = permissions.has('members.remove');

  function handleRoleChange(member: Member, role: RoleKey) {
    if (role === member.role.key) return;
    setActionError(null);
    changeRole.mutate(
      { membershipId: member.id, role },
      { onError: setActionError },
    );
  }

  function handleRemove(member: Member) {
    const confirmed = window.confirm(
      `Remove ${member.user.displayName} from this organization?`,
    );
    if (!confirmed) return;
    setActionError(null);
    removeMember.mutate(
      { membershipId: member.id },
      { onError: setActionError },
    );
  }

  return (
    <div>
      <h1 className="page-title">Members</h1>
      <p className="page-intro">People with an active membership in this organization.</p>

      {actionError != null && <ErrorBanner error={actionError} />}
      {!canChangeRole && !canRemove && (
        <PermissionNote>
          You can view members but cannot change roles or remove members in this
          organization.
        </PermissionNote>
      )}

      <div className="card">
        <QueryBoundary isLoading={query.isLoading} error={query.error}>
          {items.length === 0 ? (
            <EmptyState>No members yet.</EmptyState>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Member</th>
                  <th>Role</th>
                  <th>Joined</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {items.map((member) => (
                  <tr key={member.id}>
                    <td>
                      <div>{member.user.displayName}</div>
                      <div className="muted" style={{ fontSize: '0.82rem' }}>
                        {member.user.email}
                      </div>
                    </td>
                    <td>
                      <select
                        className="select"
                        value={member.role.key}
                        disabled={!canChangeRole || changeRole.isPending}
                        onChange={(event) =>
                          handleRoleChange(
                            member,
                            event.target.value as RoleKey,
                          )
                        }
                      >
                        {ROLE_KEY_ORDER.map((roleKey) => (
                          <option key={roleKey} value={roleKey}>
                            {roleKey}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="muted">{formatDate(member.joinedAt)}</td>
                    <td>
                      <button
                        className="btn btn-sm btn-danger"
                        disabled={!canRemove || removeMember.isPending}
                        onClick={() => handleRemove(member)}
                      >
                        Remove
                      </button>
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
