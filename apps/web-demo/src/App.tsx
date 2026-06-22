import { routes } from './routes';
import { NotFoundPage } from './pages/NotFoundPage';

/**
 * Application shell.
 *
 * Resolves the current pathname against the route registry. No client-side
 * navigation library yet — that arrives with the first real feature screens.
 */
export function App() {
  const path = window.location.pathname;
  const match = routes.find((route) => route.path === path);
  const Page = match?.component ?? NotFoundPage;
  return <Page />;
}
