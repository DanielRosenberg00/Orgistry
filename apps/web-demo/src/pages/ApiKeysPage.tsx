import { useState } from 'react';
import {
  API_KEY_SCOPE_LIST,
  type ApiKey,
  type ApiKeyScope,
} from '@orgistry/contracts';
import {
  useApiKeys,
  useCreateApiKey,
  useRevokeApiKey,
} from '../hooks/useApiKeys';
import { useEntitlements } from '../hooks/usePlan';
import { useEffectivePermissions } from '../hooks/useEffectivePermissions';
import { ErrorBanner } from '../components/ErrorBanner';
import { PermissionNote } from '../components/PermissionNote';
import {
  EmptyState,
  LoadMore,
  QueryBoundary,
} from '../components/QueryStates';
import { formatDateTimeOrDash } from '../lib/format';

/**
 * API key management.
 *
 * SECURITY INVARIANT: the raw secret is returned by the backend exactly once, on
 * creation. It lives ONLY in short-lived component state here — it is never
 * written to a query cache, localStorage, or anywhere else, and is cleared when
 * the user dismisses it. After that it is unrecoverable. There is no rotation
 * and no secret-reveal surface (by design).
 */
export function ApiKeysPage() {
  const { query, items } = useApiKeys();
  const entitlements = useEntitlements();
  const permissions = useEffectivePermissions();
  const createApiKey = useCreateApiKey();
  const revokeApiKey = useRevokeApiKey();

  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ApiKeyScope[]>([...API_KEY_SCOPE_LIST]);
  const [formError, setFormError] = useState<unknown>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  // The one-time raw secret. Short-lived: cleared on dismiss, never persisted.
  const [newSecret, setNewSecret] = useState<{ name: string; secret: string } | null>(
    null,
  );

  const canCreate = permissions.has('api_keys.create');
  const canRevoke = permissions.has('api_keys.revoke');
  const keysEnabled = entitlements.data?.entitlements.api_keys_access ?? true;

  function toggleScope(scope: ApiKeyScope) {
    setScopes((current) =>
      current.includes(scope)
        ? current.filter((s) => s !== scope)
        : [...current, scope],
    );
  }

  function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    setFormError(null);
    createApiKey.mutate(
      { name: name.trim(), scopes },
      {
        onSuccess: (result) => {
          setNewSecret({ name: result.apiKey.name, secret: result.secret });
          setName('');
          setScopes([...API_KEY_SCOPE_LIST]);
        },
        onError: setFormError,
      },
    );
  }

  function handleRevoke(apiKeyId: string) {
    if (!window.confirm('Revoke this API key? It cannot be undone.')) return;
    setActionError(null);
    revokeApiKey.mutate({ apiKeyId }, { onError: setActionError });
  }

  return (
    <div>
      <h1 className="page-title">API keys</h1>
      <p className="page-intro">Organization-scoped machine credentials.</p>

      {!keysEnabled && (
        <div className="banner banner-info">
          This organization&apos;s plan does not include API key access
          (<code>api_keys_access</code>). Upgrade the demo plan to create keys.
        </div>
      )}

      {newSecret && (
        <OneTimeSecret
          name={newSecret.name}
          secret={newSecret.secret}
          onDismiss={() => {
            setNewSecret(null);
            // Also drop the secret from the mutation observer's retained result,
            // so it lives nowhere after dismissal.
            createApiKey.reset();
          }}
        />
      )}

      <div className="card">
        <h2>Create API key</h2>
        {formError != null && <ErrorBanner error={formError} />}
        <form onSubmit={handleCreate} className="stack">
          <div className="field" style={{ maxWidth: 360 }}>
            <label htmlFor="key-name">Name</label>
            <input
              id="key-name"
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              disabled={!canCreate}
            />
          </div>
          <fieldset style={{ border: 'none', padding: 0, margin: 0 }}>
            <legend className="muted" style={{ fontSize: '0.85rem' }}>
              Scopes
            </legend>
            {API_KEY_SCOPE_LIST.map((scope) => (
              <label key={scope} className="row" style={{ gap: '0.4rem' }}>
                <input
                  type="checkbox"
                  checked={scopes.includes(scope)}
                  onChange={() => toggleScope(scope)}
                  disabled={!canCreate}
                />
                <code>{scope}</code>
              </label>
            ))}
          </fieldset>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={!canCreate || scopes.length === 0 || createApiKey.isPending}
          >
            {createApiKey.isPending ? 'Creating…' : 'Create key'}
          </button>
        </form>
        {!canCreate && (
          <PermissionNote>
            You do not have permission to create API keys in this organization.
          </PermissionNote>
        )}
      </div>

      <div className="card">
        <h2>Existing keys</h2>
        {actionError != null && <ErrorBanner error={actionError} />}
        <QueryBoundary isLoading={query.isLoading} error={query.error}>
          {items.length === 0 ? (
            <EmptyState>No API keys yet.</EmptyState>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Identifier</th>
                  <th>Scopes</th>
                  <th>Status</th>
                  <th>Last used</th>
                  <th>Expires</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {items.map((apiKey) => (
                  <ApiKeyRow
                    key={apiKey.id}
                    apiKey={apiKey}
                    canRevoke={canRevoke}
                    isRevoking={revokeApiKey.isPending}
                    onRevoke={() => handleRevoke(apiKey.id)}
                  />
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

/**
 * The one-and-only display of a freshly created key's raw secret. Shown until
 * dismissed, with an explicit warning that it will not be shown again.
 */
function OneTimeSecret({
  name,
  secret,
  onDismiss,
}: {
  name: string;
  secret: string;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="banner banner-success" role="status">
      <strong>API key “{name}” created.</strong>
      <p style={{ margin: '0.4rem 0' }}>
        Copy this secret now — it will <strong>not</strong> be shown again and is
        not stored anywhere it can be retrieved.
      </p>
      <div className="secret-box">{secret}</div>
      <div className="row" style={{ marginTop: '0.5rem' }}>
        <button className="btn btn-sm" onClick={copy}>
          {copied ? 'Copied' : 'Copy secret'}
        </button>
        <button className="btn btn-sm" onClick={onDismiss}>
          Done
        </button>
      </div>
    </div>
  );
}

function ApiKeyRow({
  apiKey,
  canRevoke,
  isRevoking,
  onRevoke,
}: {
  apiKey: ApiKey;
  canRevoke: boolean;
  isRevoking: boolean;
  onRevoke: () => void;
}) {
  return (
    <tr>
      <td>{apiKey.name}</td>
      <td>
        <code>{apiKey.displayPrefix}</code>
      </td>
      <td>{apiKey.scopes.join(', ')}</td>
      <td>
        <span
          className={
            apiKey.status === 'active' ? 'badge badge-active' : 'badge badge-danger'
          }
        >
          {apiKey.status}
        </span>
      </td>
      <td className="muted">{formatDateTimeOrDash(apiKey.lastUsedAt)}</td>
      <td className="muted">{formatDateTimeOrDash(apiKey.expiresAt)}</td>
      <td>
        {apiKey.status === 'active' && (
          <button
            className="btn btn-sm btn-danger"
            disabled={!canRevoke || isRevoking}
            onClick={onRevoke}
          >
            Revoke
          </button>
        )}
      </td>
    </tr>
  );
}
