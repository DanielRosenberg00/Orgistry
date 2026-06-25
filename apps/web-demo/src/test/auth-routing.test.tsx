import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { mockApi, renderApp } from './harness';

/** Auth + route-guard smoke coverage. */
describe('auth and routing', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('renders the login screen', async () => {
    mockApi({ authenticated: false });
    renderApp('/auth/login');
    expect(
      await screen.findByRole('heading', { name: /sign in to orgistry/i }),
    ).toBeInTheDocument();
  });

  it('redirects an unauthenticated user away from a protected route', async () => {
    mockApi({ authenticated: false });
    renderApp('/app/overview');
    // The boot refresh fails, so the guard sends the user to login.
    expect(
      await screen.findByRole('heading', { name: /sign in to orgistry/i }),
    ).toBeInTheDocument();
  });

  it('restores a session and renders the authenticated shell', async () => {
    mockApi({ authenticated: true });
    renderApp('/app/overview');
    // The org name appears in the shell top bar once the session is restored.
    await waitFor(() =>
      expect(screen.getAllByText(/acme inc/i).length).toBeGreaterThan(0),
    );
    expect(screen.getByText(/log out/i)).toBeInTheDocument();
  });
});
