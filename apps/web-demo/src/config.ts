/**
 * Web demo configuration values, resolved once at module load.
 *
 * The web demo is a thin official consumer of the Orgistry HTTP API. The only
 * things it needs to know about its environment are where the API lives, the
 * name of the custom CSRF header the backend requires on cookie-backed auth
 * mutations (refresh/logout), and — for local development guidance only — the
 * Mailpit UI.
 *
 * All three are RUNTIME public configuration since the Sprint 26 refinement, so
 * one built web image can serve any environment. The resolution rules, the
 * precedence order, and the guard that keeps secrets out of the browser live in
 * [public-config.ts](./public-config.ts).
 */

import { readPublicConfig } from './public-config';

const config = readPublicConfig();

/** Base URL of the Orgistry API (no trailing slash). */
export const API_BASE_URL = config.apiBaseUrl;

/**
 * Custom header the backend requires on cookie-backed mutations. Its presence
 * (any non-empty value) is what satisfies the server's CSRF guard — see the
 * backend auth route's `requireCsrfHeader`. Must match `AUTH_CSRF_HEADER_NAME`.
 */
export const CSRF_HEADER_NAME = config.csrfHeaderName;

/**
 * Mailpit web UI, where invitation emails (and their raw tokens) are delivered
 * in local development. The admin UI never displays raw invitation tokens — it
 * points operators here instead. See the invitations page.
 */
export const MAILPIT_URL = config.mailpitUrl;
