import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { mockApi, renderApp, route, ok } from './harness';
import { effectivePermissions } from './fixtures';

/**
 * Admin-surface smoke coverage: organization switcher, projects, audit, and the
 * permission-aware disabling of an action. Each test boots a real authenticated
 * session through the provider tree and the mocked API.
 */
describe('admin surfaces', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows the organization switcher with the user organizations', async () => {
    mockApi({ authenticated: true });
    renderApp('/app/overview');
    // The org list loads asynchronously, so wait for its option to populate.
    const option = await screen.findByRole('option', { name: /acme inc/i });
    expect(option).toBeInTheDocument();
  });

  it('renders the projects list and a create affordance', async () => {
    mockApi({ authenticated: true });
    renderApp('/app/projects');
    expect(
      await screen.findByRole('heading', { name: /^projects$/i }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText(/website redesign/i)).toBeInTheDocument(),
    );
    expect(
      screen.getByRole('button', { name: /create project/i }),
    ).toBeEnabled();
  });

  it('renders audit events from their DTOs, including the request id', async () => {
    mockApi({ authenticated: true });
    renderApp('/app/audit');
    expect(
      await screen.findByRole('heading', { name: /audit log/i }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText('project.created')).toBeInTheDocument(),
    );
    expect(screen.getByText('req_demo_123')).toBeInTheDocument();
    expect(screen.getByText(/retention policy/i)).toBeInTheDocument();
  });

  it('disables member actions when the permission is absent (UX hint)', async () => {
    // An Owner-less effective set: read members but cannot change roles/remove.
    mockApi({
      authenticated: true,
      overrides: [
        route('GET', /\/permissions\/effective$/, () =>
          ok(effectivePermissions(['org.read', 'members.read'])),
        ),
      ],
    });
    renderApp('/app/members');
    await waitFor(() =>
      expect(screen.getByText('bea@example.com')).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /remove/i })).toBeDisabled();
    expect(
      screen.getByText(/cannot change roles or remove members/i),
    ).toBeInTheDocument();
  });
});
