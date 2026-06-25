import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { AuthProvider } from './auth/AuthProvider';
import { OrganizationProvider } from './organization/OrganizationProvider';
import { createQueryClient } from './queryClient';
import './styles.css';

/**
 * App bootstrap. Provider order (outer → inner):
 *   BrowserRouter        — routing context
 *   QueryClientProvider  — TanStack Query cache (auth/org providers use it)
 *   AuthProvider         — in-memory access token + session restore
 *   OrganizationProvider — organization list + selected-org context
 */
const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element #root not found');
}

const queryClient = createQueryClient();

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <OrganizationProvider>
            <App />
          </OrganizationProvider>
        </AuthProvider>
      </QueryClientProvider>
    </BrowserRouter>
  </StrictMode>,
);
