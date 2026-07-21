import type { Config } from '@orgistry/config';
import type { InMemoryAccountMailer } from '../../mail/testing/in-memory-account-mailer';
import {
  createRegistrationService,
  type RegistrationService,
} from '../registration.service';
import type { RegistrationInvitations } from '../registration.types';
import type { InMemoryAuthRepository } from './in-memory-auth-repo';
import {
  createInMemoryRegistrationRepository,
  type InMemoryRegistrationRepository,
} from './in-memory-registration-repo';

/**
 * Wire an in-memory registration service over the SAME stores as an existing
 * in-memory auth repository, mirroring server.ts. Used by every test-app
 * builder whose suites create users through the public registration flow
 * (Sprint 18: request -> emailed token -> completion).
 */
export function createRegistrationTestKit(input: {
  config: Config;
  authRepo: InMemoryAuthRepository;
  mailer: InMemoryAccountMailer;
  invitations?: RegistrationInvitations;
}): {
  registrationService: RegistrationService;
  registrationRepo: InMemoryRegistrationRepository;
} {
  const { config, authRepo, mailer } = input;
  const registrationRepo = createInMemoryRegistrationRepository({
    orgStore: authRepo.orgStore,
    sessions: authRepo.sessions,
    refreshTokens: authRepo.refreshTokens,
    securityEvents: authRepo.securityEvents,
  });
  const registrationService = createRegistrationService({
    repo: registrationRepo,
    mailer,
    webBaseUrl: config.web.url,
    completionTtlSeconds: config.registration.completionTtlSeconds,
    jwtSecret: config.auth.jwtSecret,
    accessTokenTtlSeconds: config.auth.accessTokenTtlSeconds,
    sessionTtlSeconds: config.auth.sessionTtlSeconds,
    refreshTokenTtlSeconds: config.auth.refreshTokenTtlSeconds,
    invitations: input.invitations,
  });
  return { registrationService, registrationRepo };
}
