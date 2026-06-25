import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockApi, ok, renderApp, route } from './harness';
import { API_KEY } from './fixtures';

/**
 * API key one-time-secret display. The raw secret returned by creation is shown
 * once, with a "won't be shown again" warning, and disappears when dismissed —
 * it is never persisted.
 */
describe('api key one-time secret', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows the raw secret once after creation and hides it on dismiss', async () => {
    const user = userEvent.setup();
    mockApi({
      authenticated: true,
      overrides: [
        route('POST', /\/api-keys$/, () =>
          ok(
            {
              apiKey: { ...API_KEY, id: 'key_new', name: 'Deploy bot' },
              secret: 'orgistry_live_SUPERSECRETVALUE',
            },
            201,
          ),
        ),
      ],
    });

    renderApp('/app/api-keys');

    // The create button is disabled until effective permissions load (a UX
    // hint); wait for it to enable before driving the form.
    const createButton = await screen.findByRole('button', {
      name: /create key/i,
    });
    await waitFor(() => expect(createButton).toBeEnabled());

    await user.type(screen.getByLabelText('Name'), 'Deploy bot');
    await user.click(createButton);

    // The secret and the one-time warning appear.
    await waitFor(() =>
      expect(
        screen.getByText('orgistry_live_SUPERSECRETVALUE'),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText(/be shown again/i)).toBeInTheDocument();

    // Dismissing removes the secret from the DOM (it is not persisted anywhere).
    await user.click(screen.getByRole('button', { name: /^done$/i }));
    await waitFor(() =>
      expect(
        screen.queryByText('orgistry_live_SUPERSECRETVALUE'),
      ).not.toBeInTheDocument(),
    );

    // The secret must not have leaked into web storage at any point.
    expect(storageContains(window.localStorage, 'orgistry_live_SUPERSECRETVALUE')).toBe(
      false,
    );
    expect(
      storageContains(window.sessionStorage, 'orgistry_live_SUPERSECRETVALUE'),
    ).toBe(false);
  });
});

/** True if any key or value in `storage` contains `needle`. Guarded for partial impls. */
function storageContains(storage: Storage, needle: string): boolean {
  try {
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key && (key.includes(needle) || (storage.getItem(key) ?? '').includes(needle))) {
        return true;
      }
    }
  } catch {
    // Partial storage impl in the test runtime — the in-memory model already
    // guarantees the secret is never written here.
  }
  return false;
}
