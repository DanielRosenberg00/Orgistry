import type { FastifyInstance } from 'fastify';
import type {
  RegistrationCompleteResponse,
  RegistrationInvitationOutcome,
} from '@orgistry/contracts';
import type { InMemoryAccountMailer } from '../../mail/testing/in-memory-account-mailer';

/**
 * Shared test helper for the Sprint 18 verification-first registration flow.
 *
 * Registration is now two-step (request -> emailed completion token ->
 * complete), so every suite that needs an authenticated user drives BOTH
 * public endpoints — exactly the path a real user takes — and recovers the
 * completion token from the captured email, the same out-of-band channel a
 * real recipient would use. The API itself never returns the token.
 */

export interface RegisterTestUserInput {
  email: string;
  password: string;
  displayName: string;
  invitationToken?: string;
}

export interface RegisterTestUserResult {
  /** Bearer access token from the completed registration. */
  accessToken: string;
  userId: string;
  /** The full completion response body (user, tokens, invitation outcome). */
  completion: RegistrationCompleteResponse;
  /** The completion response's set-cookie header(s), for cookie assertions. */
  setCookie: string | string[] | undefined;
  /** The invitation outcome reported by completion (null without invitation). */
  invitation: RegistrationInvitationOutcome | null;
}

/** Extract the raw completion token from a captured completion email body. */
export function completionTokenFromEmailText(text: string): string | null {
  const match = text.match(/\/auth\/complete-registration#token=([^\s&]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Find the most recent completion token emailed to `email`, or null. Guidance
 * notices to existing accounts carry no token and are skipped naturally.
 */
export function lastCompletionTokenFor(
  mailer: InMemoryAccountMailer,
  email: string,
): string | null {
  for (let i = mailer.messages.length - 1; i >= 0; i -= 1) {
    const message = mailer.messages[i];
    if (message.to !== email) {
      continue;
    }
    const token = completionTokenFromEmailText(message.text);
    if (token) {
      return token;
    }
  }
  return null;
}

/**
 * Register a user through the full request + completion flow and return the
 * authenticated result. Fails the test loudly if any step deviates from the
 * happy-path contract.
 */
export async function registerTestUser(
  app: FastifyInstance,
  mailer: InMemoryAccountMailer,
  input: RegisterTestUserInput,
): Promise<RegisterTestUserResult> {
  const requestResponse = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: {
      email: input.email,
      password: input.password,
      displayName: input.displayName,
      ...(input.invitationToken
        ? { invitationToken: input.invitationToken }
        : {}),
    },
  });
  if (requestResponse.statusCode !== 200) {
    throw new Error(
      `registerTestUser: registration request failed (${requestResponse.statusCode}): ${requestResponse.body}`,
    );
  }

  const rawToken = lastCompletionTokenFor(mailer, input.email.trim());
  if (!rawToken) {
    throw new Error(
      `registerTestUser: no completion email captured for ${input.email}`,
    );
  }

  const completeResponse = await app.inject({
    method: 'POST',
    url: '/v1/auth/registration/complete',
    payload: { token: rawToken },
  });
  if (completeResponse.statusCode !== 201) {
    throw new Error(
      `registerTestUser: completion failed (${completeResponse.statusCode}): ${completeResponse.body}`,
    );
  }

  const completion = completeResponse.json().data as RegistrationCompleteResponse;
  return {
    accessToken: completion.tokens.accessToken,
    userId: completion.user.id,
    completion,
    setCookie: completeResponse.headers['set-cookie'],
    invitation: completion.invitation,
  };
}
