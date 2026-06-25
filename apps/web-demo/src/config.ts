/**
 * Web demo runtime configuration.
 *
 * The web demo is a thin official consumer of the Orgistry HTTP API. The only
 * things it needs to know about its environment are where the API lives and the
 * name of the custom CSRF header the backend requires on cookie-backed auth
 * mutations (refresh/logout). Both are read from Vite env vars with local-dev
 * defaults that match `.env.example` so the demo runs with zero configuration.
 */

/** Base URL of the Orgistry API (no trailing slash). */
export const API_BASE_URL = stripTrailingSlash(
  import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000',
);

/**
 * Custom header the backend requires on cookie-backed mutations. Its presence
 * (any non-empty value) is what satisfies the server's CSRF guard — see the
 * backend auth route's `requireCsrfHeader`. Must match `AUTH_CSRF_HEADER_NAME`.
 */
export const CSRF_HEADER_NAME =
  import.meta.env.VITE_CSRF_HEADER_NAME ?? 'x-orgistry-csrf';

/**
 * Mailpit web UI, where invitation emails (and their raw tokens) are delivered
 * in local development. The admin UI never displays raw invitation tokens — it
 * points operators here instead. See the invitations page.
 */
export const MAILPIT_URL =
  import.meta.env.VITE_MAILPIT_URL ?? 'http://localhost:8025';

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}
