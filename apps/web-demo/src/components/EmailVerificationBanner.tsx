import { useState } from 'react';
import type { EmailVerificationRequestResponse } from '@orgistry/contracts';
import { api } from '../api/client';
import { toApiError } from '../api/errors';
import { useAuth } from '../auth/useAuth';

/**
 * Unverified-email banner (Sprint 16).
 *
 * Shown across the authenticated shell while the backend reports
 * `user.emailVerified === false`. Verification is ADVISORY in Sprint 16, so
 * the banner informs and offers a resend — it never blocks any surface.
 *
 * The resend action calls the authenticated request endpoint, which operates
 * only on the current user's stored email (no address is ever submitted from
 * the client). All state here is presentation-only; the verified flag itself
 * always comes from the backend via `useAuth().user`.
 */

type ResendState =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'sent' }
  | { kind: 'rate_limited' }
  | { kind: 'failed'; message: string };

export function EmailVerificationBanner() {
  const { user, refreshUser } = useAuth();
  const [resend, setResend] = useState<ResendState>({ kind: 'idle' });

  if (!user || user.emailVerified) {
    return null;
  }

  async function handleResend() {
    setResend({ kind: 'pending' });
    try {
      const response = await api.post<EmailVerificationRequestResponse>(
        '/v1/auth/email-verification/request',
      );
      if (response.alreadyVerified) {
        // Another tab/device completed verification; adopt the backend state.
        await refreshUser();
        return;
      }
      setResend({ kind: 'sent' });
    } catch (caught) {
      const error = toApiError(caught);
      if (error.code === 'RATE_LIMITED') {
        setResend({ kind: 'rate_limited' });
      } else {
        setResend({ kind: 'failed', message: error.message });
      }
    }
  }

  return (
    <div className="banner banner-info" role="status">
      <strong>Verify your email address.</strong>{' '}
      We sent a verification link to <strong>{user.email}</strong>. Follow it to
      confirm this address belongs to you.
      <span style={{ marginLeft: '0.75rem' }}>
        <button
          className="btn btn-sm"
          onClick={handleResend}
          disabled={resend.kind === 'pending'}
        >
          {resend.kind === 'pending' ? 'Sending…' : 'Resend email'}
        </button>
      </span>
      {resend.kind === 'sent' && (
        <span className="muted" style={{ marginLeft: '0.5rem' }}>
          Verification email sent.
        </span>
      )}
      {resend.kind === 'rate_limited' && (
        <span className="muted" style={{ marginLeft: '0.5rem' }}>
          Too many requests — wait a minute before trying again.
        </span>
      )}
      {resend.kind === 'failed' && (
        <span className="muted" style={{ marginLeft: '0.5rem' }}>
          Could not send the email right now. Try again shortly.
        </span>
      )}
    </div>
  );
}
