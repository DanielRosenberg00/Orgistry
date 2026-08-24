import { describe, expect, it } from 'vitest';
import {
  PUBLIC_CONFIG_DEFAULTS,
  assertNoSecretFields,
  resolvePublicConfig,
} from './public-config';

/**
 * The runtime public-configuration boundary is what makes one web image
 * promotable between environments (Sprint 26 refinement). These tests pin the
 * three properties the deployment model depends on:
 *
 *   1. the SAME bundle resolves different API origins from different runtime
 *      objects — no rebuild is involved anywhere in this file;
 *   2. precedence is runtime -> build-time -> default, so a deployed container
 *      always wins over whatever the image was built with;
 *   3. a credential-shaped key is refused rather than published to browsers.
 */

describe('resolvePublicConfig', () => {
  it('serves two different API origins from one bundle', () => {
    const staging = resolvePublicConfig({ apiBaseUrl: 'https://api.staging.example.test' });
    const production = resolvePublicConfig({ apiBaseUrl: 'https://api.example.test' });

    expect(staging.apiBaseUrl).toBe('https://api.staging.example.test');
    expect(production.apiBaseUrl).toBe('https://api.example.test');
  });

  it('prefers runtime configuration over the build-time value', () => {
    const config = resolvePublicConfig(
      { apiBaseUrl: 'https://api.example.test' },
      { VITE_API_BASE_URL: 'http://baked-in.example.test' },
    );
    expect(config.apiBaseUrl).toBe('https://api.example.test');
  });

  it('falls back to the build-time value when the runtime object omits a key', () => {
    const config = resolvePublicConfig({}, { VITE_API_BASE_URL: 'http://dev.example.test' });
    expect(config.apiBaseUrl).toBe('http://dev.example.test');
  });

  it('falls back to the built-in defaults when nothing is configured', () => {
    expect(resolvePublicConfig(null)).toEqual(PUBLIC_CONFIG_DEFAULTS);
  });

  it('treats a blank runtime value as unconfigured', () => {
    // An unsubstituted or cleared container variable renders as an empty
    // string; that must not become the API origin.
    const config = resolvePublicConfig({ apiBaseUrl: '   ' });
    expect(config.apiBaseUrl).toBe(PUBLIC_CONFIG_DEFAULTS.apiBaseUrl);
  });

  it('strips a trailing slash so request paths never double up', () => {
    expect(resolvePublicConfig({ apiBaseUrl: 'https://api.example.test/' }).apiBaseUrl).toBe(
      'https://api.example.test',
    );
  });

  it('ignores unrecognised, non-secret keys', () => {
    const config = resolvePublicConfig({ apiBaseUrl: 'https://api.example.test', theme: 'dark' });
    expect(config).toEqual({ ...PUBLIC_CONFIG_DEFAULTS, apiBaseUrl: 'https://api.example.test' });
  });
});

describe('assertNoSecretFields', () => {
  it('accepts the recognised public configuration keys', () => {
    expect(() =>
      assertNoSecretFields({
        apiBaseUrl: 'https://api.example.test',
        csrfHeaderName: 'x-orgistry-csrf',
        mailpitUrl: 'http://localhost:8025',
      }),
    ).not.toThrow();
  });

  it.each([
    'jwtSecret',
    'smtpPassword',
    'databaseCredential',
    'apiKey',
    'api_key',
    'accessToken',
    'signingKey',
  ])('refuses the credential-shaped key %s', (key) => {
    expect(() => assertNoSecretFields({ [key]: 'value' })).toThrow(/credential-shaped/);
  });

  it('refuses a secret even when it arrives alongside valid configuration', () => {
    expect(() =>
      resolvePublicConfig({ apiBaseUrl: 'https://api.example.test', jwtSecret: 'leaked' }),
    ).toThrow(/never carry a secret/);
  });
});
