import type { RefreshResponse } from '@orgistry/contracts';
import { API_BASE_URL, CSRF_HEADER_NAME } from '../config';
import { ApiError } from './errors';

/**
 * The one central Orgistry API client.
 *
 * Every network call in the web demo goes through here — page components and
 * hooks never call `fetch` directly. The client owns four cross-cutting
 * concerns so no page has to repeat them:
 *
 *   1. Envelope handling — unwraps `{ ok: true, data }` to `data`, and turns
 *      `{ ok: false, error }` into a typed {@link ApiError}.
 *   2. Access token — the in-memory bearer token is injected on authenticated
 *      requests. It is held ONLY in this module's closure: never localStorage,
 *      never sessionStorage. A full page reload deliberately drops it (session
 *      is restored from the refresh cookie at boot — see AuthProvider).
 *   3. Cookie + CSRF — refresh/logout send the HttpOnly refresh cookie
 *      (`credentials: include`) and the custom CSRF header the backend requires.
 *   4. Silent refresh — a 401 on an authenticated request triggers a single
 *      single-flight refresh + one retry, so a merely-expired access token does
 *      not bounce the user to the login screen.
 */

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

type QueryValue = string | number | boolean | null | undefined;

interface RequestOptions {
  /** Query string params. Null/undefined values are omitted. */
  query?: Record<string, QueryValue>;
  /** JSON request body. Serialized with `JSON.stringify`. */
  body?: unknown;
  signal?: AbortSignal;
  /** Attach the in-memory bearer token. Default true. */
  authenticated?: boolean;
  /**
   * Send the HttpOnly refresh cookie (`credentials: include`) and the CSRF
   * header. Used only by the cookie-backed auth mutations (refresh/logout).
   * Default false.
   */
  cookieAuth?: boolean;
  /** Internal: set after one silent-refresh retry to prevent recursion. */
  retried?: boolean;
}

// --- In-memory access token (never persisted) -----------------------------

let accessToken: string | null = null;

/** Replace the in-memory access token (null clears it). */
export function setAccessToken(token: string | null): void {
  accessToken = token;
}

/** Read the current in-memory access token, if any. */
export function getAccessToken(): string | null {
  return accessToken;
}

// --- Session-expiry notification ------------------------------------------

type SessionExpiredListener = () => void;
let sessionExpiredListener: SessionExpiredListener | null = null;

/**
 * Register the callback fired when a silent refresh fails (the session is no
 * longer recoverable). AuthProvider uses this to drop the user to login.
 */
export function onSessionExpired(listener: SessionExpiredListener): void {
  sessionExpiredListener = listener;
}

// --- Core request ---------------------------------------------------------

async function request<T>(
  method: Method,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const { authenticated = true, cookieAuth = false } = options;

  const url = buildUrl(path, options.query);
  const headers: Record<string, string> = { Accept: 'application/json' };

  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (authenticated && accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }
  if (cookieAuth) {
    // The backend's CSRF guard only checks the header is PRESENT; any non-empty
    // value satisfies it (the real protection is SameSite + the CORS allowlist).
    headers[CSRF_HEADER_NAME] = '1';
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      credentials: cookieAuth ? 'include' : 'same-origin',
      signal: options.signal,
    });
  } catch (cause) {
    // Network failure / CORS / aborted — never reached an envelope.
    throw ApiError.unexpected(
      cause instanceof Error && cause.name === 'AbortError'
        ? 'The request was cancelled.'
        : 'Could not reach the Orgistry API. Is it running?',
    );
  }

  const envelope = await parseEnvelope(response);

  if (envelope.ok) {
    return envelope.data as T;
  }

  // A merely-expired access token: try one silent refresh + retry.
  if (
    response.status === 401 &&
    authenticated &&
    !cookieAuth &&
    !options.retried &&
    (await trySilentRefresh())
  ) {
    return request<T>(method, path, { ...options, retried: true });
  }

  if (response.status === 401 && authenticated && !cookieAuth) {
    // Refresh did not recover the session — surface it to the auth layer.
    notifySessionExpired();
  }

  throw new ApiError(
    envelope.error.code,
    envelope.error.message,
    response.status,
    envelope.error.requestId,
    envelope.error.details,
  );
}

// --- Silent refresh (single-flight) ---------------------------------------

let refreshInFlight: Promise<boolean> | null = null;

/**
 * Attempt to mint a fresh access token from the refresh cookie. Coalesces
 * concurrent callers onto one in-flight refresh so a burst of 401s triggers a
 * single network round-trip.
 */
async function trySilentRefresh(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = refreshAccessToken().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

/**
 * Exchange the HttpOnly refresh cookie for a new access token. Exposed so the
 * AuthProvider can run it at app boot to restore a session. Returns true and
 * stores the new token on success; returns false on any failure (and leaves the
 * token cleared).
 */
export async function refreshAccessToken(): Promise<boolean> {
  try {
    const data = await request<RefreshResponse>('POST', '/v1/auth/refresh', {
      authenticated: false,
      cookieAuth: true,
    });
    setAccessToken(data.tokens.accessToken);
    return true;
  } catch {
    setAccessToken(null);
    return false;
  }
}

function notifySessionExpired(): void {
  setAccessToken(null);
  sessionExpiredListener?.();
}

// --- Helpers ---------------------------------------------------------------

interface SuccessBody {
  ok: true;
  data: unknown;
}
interface ErrorBody {
  ok: false;
  error: {
    code: ApiError['code'];
    message: string;
    requestId: string;
    details?: unknown;
  };
}

async function parseEnvelope(
  response: Response,
): Promise<SuccessBody | ErrorBody> {
  // The backend echoes the resolved request id on every response. A well-formed
  // error envelope also carries it in the body (and that is what callers see for
  // normal errors); the header is the only correlation id available when the
  // body is missing/non-JSON (e.g. a proxy 502), so it backs the fallback below.
  const headerRequestId = readRequestIdHeader(response);

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw ApiError.unexpected(
      `The API returned a non-JSON response (HTTP ${response.status}).`,
      response.status,
      headerRequestId,
    );
  }
  if (isEnvelope(json)) {
    return json;
  }
  throw ApiError.unexpected(
    `The API returned an unrecognized response (HTTP ${response.status}).`,
    response.status,
    headerRequestId,
  );
}

/** Safely read the backend's `x-request-id` echo header, if present. */
function readRequestIdHeader(response: Response): string | null {
  try {
    return response.headers?.get?.('x-request-id') ?? null;
  } catch {
    return null;
  }
}

function isEnvelope(value: unknown): value is SuccessBody | ErrorBody {
  if (typeof value !== 'object' || value === null || !('ok' in value)) {
    return false;
  }
  const ok = (value as { ok: unknown }).ok;
  if (ok === true) return 'data' in value;
  if (ok === false) return 'error' in value;
  return false;
}

function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  const url = new URL(`${API_BASE_URL}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== null && value !== undefined && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
}

// --- Public verb helpers ---------------------------------------------------

export const api = {
  get: <T>(path: string, options?: RequestOptions) =>
    request<T>('GET', path, options),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('POST', path, { ...options, body }),
  patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('PATCH', path, { ...options, body }),
  del: <T>(path: string, options?: RequestOptions) =>
    request<T>('DELETE', path, options),
};
