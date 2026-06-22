import type { ErrorCode } from '@orgistry/contracts';
import { ERROR_CODES } from '@orgistry/contracts';

/**
 * Foundation status page.
 *
 * Deliberately shows NO product/domain state — no fake auth, organizations,
 * permissions, projects, plans, API keys, or audit data. It exists to prove the
 * web shell boots and consumes the shared `@orgistry/contracts` package, and to
 * state plainly that domain capabilities are not implemented yet.
 */
const implemented = [
  'TypeScript pnpm monorepo',
  'Typed configuration (@orgistry/config)',
  'API contracts & error catalog (@orgistry/contracts)',
  'Shared primitives: prefixed IDs, request IDs, cursors (@orgistry/shared)',
  'Database foundation & migrations (@orgistry/db)',
  'Fastify API shell: health, readiness, envelopes, error handling',
  'This React/Vite shell',
];

const notImplemented = [
  'Authentication (registration, login, sessions, tokens)',
  'Organizations, memberships, roles, permissions',
  'Entitlements, quotas, projects, API keys',
  'Invitations, audit & security events',
  'Any product UI',
];

export function FoundationStatusPage() {
  // Demonstrates real consumption of the shared contracts package.
  const errorCodeSample: ErrorCode = ERROR_CODES.NOT_FOUND;

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 720, margin: '3rem auto', padding: '0 1rem', lineHeight: 1.5 }}>
      <h1>Orgistry — Sprint 1 Foundation</h1>
      <p>
        This is the foundation shell. No product or domain capabilities are
        implemented yet. This page renders static status only and intentionally
        holds no application state.
      </p>

      <h2>Implemented</h2>
      <ul>
        {implemented.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>

      <h2>Not implemented yet</h2>
      <ul>
        {notImplemented.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>

      <p style={{ color: '#666', fontSize: '0.85rem' }}>
        Shared contracts available to the client (sample error code:{' '}
        <code>{errorCodeSample}</code>).
      </p>
    </main>
  );
}
