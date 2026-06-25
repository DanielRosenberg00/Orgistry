import { ERROR_CODES } from '@orgistry/contracts';
import type {
  EntitlementErrorDetails,
  QuotaErrorDetails,
} from '@orgistry/contracts';
import { ApiError, toApiError } from '../api/errors';

/**
 * Render a backend error consistently.
 *
 * The backend already produces safe, human-readable messages, so the banner
 * shows `error.message` verbatim and never invents text from the code. For the
 * two structured-detail errors (quota / entitlement) it adds a short, specific
 * explanation parsed from `details`. The `requestId` is always shown when
 * present so an operator can correlate the failure with server logs. No backend
 * internals beyond the safe envelope fields are ever surfaced.
 */
export function ErrorBanner({ error }: { error: unknown }) {
  const apiError = toApiError(error);
  return (
    <div className="banner banner-error" role="alert">
      <div>{apiError.message}</div>
      <ErrorDetail error={apiError} />
      {apiError.requestId && (
        <div className="muted" style={{ marginTop: '0.35rem' }}>
          Request ID: <code>{apiError.requestId}</code>
        </div>
      )}
    </div>
  );
}

function ErrorDetail({ error }: { error: ApiError }) {
  if (error.is(ERROR_CODES.QUOTA_EXCEEDED) && isQuotaDetails(error.details)) {
    const { quota, limit, current } = error.details;
    return (
      <div style={{ marginTop: '0.35rem' }}>
        Quota <code>{quota}</code> reached — using {current} of {limit}. Upgrade
        the plan to raise this limit.
      </div>
    );
  }
  if (
    error.is(ERROR_CODES.ENTITLEMENT_REQUIRED) &&
    isEntitlementDetails(error.details)
  ) {
    return (
      <div style={{ marginTop: '0.35rem' }}>
        Your plan does not include <code>{error.details.entitlement}</code>.
        Change to a plan that grants it.
      </div>
    );
  }
  return null;
}

function isQuotaDetails(value: unknown): value is QuotaErrorDetails {
  return (
    typeof value === 'object' &&
    value !== null &&
    'quota' in value &&
    'limit' in value &&
    'current' in value
  );
}

function isEntitlementDetails(
  value: unknown,
): value is EntitlementErrorDetails {
  return (
    typeof value === 'object' && value !== null && 'entitlement' in value
  );
}
