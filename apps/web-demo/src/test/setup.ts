import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';
import { setAccessToken } from '../api/client';

/**
 * Shared test setup. Resets cross-test global state so suites are independent:
 * the API client's in-memory access token and the persisted org selection are
 * both cleared before each test, and React trees are unmounted after each.
 */
beforeEach(() => {
  setAccessToken(null);
  // Some runtimes expose a partial localStorage; clear defensively.
  try {
    window.localStorage.removeItem('orgistry.selectedOrganizationId');
  } catch {
    // ignore — selection only lives in memory then.
  }
});

afterEach(() => {
  cleanup();
});
