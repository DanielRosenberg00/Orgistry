/** Shared display formatting helpers. */

/** Format an ISO-8601 timestamp as a local date (e.g. for "joined" columns). */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString();
}

/** Format an ISO-8601 timestamp as a local date + time (e.g. audit events). */
export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

/** Format a nullable ISO timestamp, falling back to a dash. */
export function formatDateTimeOrDash(iso: string | null): string {
  return iso ? formatDateTime(iso) : '—';
}
