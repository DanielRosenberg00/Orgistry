import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ErrorBanner } from './ErrorBanner';
import { ApiError } from '../api/errors';

/** The standard error surface renders the message, request id, and details. */
describe('ErrorBanner', () => {
  it('renders a backend error message and its request id', () => {
    render(
      <ErrorBanner
        error={
          new ApiError(
            'FORBIDDEN',
            'You do not have permission to perform this action.',
            403,
            'req_xyz_789',
          )
        }
      />,
    );
    expect(
      screen.getByText('You do not have permission to perform this action.'),
    ).toBeInTheDocument();
    expect(screen.getByText('req_xyz_789')).toBeInTheDocument();
  });

  it('explains a quota error from its structured details', () => {
    render(
      <ErrorBanner
        error={
          new ApiError('QUOTA_EXCEEDED', 'Quota reached.', 409, 'req_q', {
            quota: 'max_projects',
            limit: 3,
            current: 3,
          })
        }
      />,
    );
    expect(screen.getByText(/using 3 of 3/i)).toBeInTheDocument();
  });

  it('coerces a non-ApiError into a safe unexpected message', () => {
    render(<ErrorBanner error={new Error('boom')} />);
    expect(screen.getByRole('alert')).toHaveTextContent('boom');
  });
});
