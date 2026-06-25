import { Navigate, Route, Routes } from 'react-router-dom';
import { ProtectedRoute } from './components/ProtectedRoute';
import { AppShell } from './components/AppShell';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { OverviewPage } from './pages/OverviewPage';
import { MembersPage } from './pages/MembersPage';
import { InvitationsPage } from './pages/InvitationsPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { PlanPage } from './pages/PlanPage';
import { ApiKeysPage } from './pages/ApiKeysPage';
import { AuditPage } from './pages/AuditPage';
import { NotFoundPage } from './pages/NotFoundPage';

/**
 * Route table.
 *
 *   /auth/login, /auth/register   — public auth screens
 *   /app/*                        — protected admin surfaces (ProtectedRoute +
 *                                   AppShell layout). Unauthenticated users are
 *                                   redirected to login by the guard.
 *
 * The route structure is the documented, stable contract for the web demo (see
 * docs/web-demo.md).
 */
export function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/app" replace />} />
      <Route path="/auth/login" element={<LoginPage />} />
      <Route path="/auth/register" element={<RegisterPage />} />

      <Route element={<ProtectedRoute />}>
        <Route path="/app" element={<AppShell />}>
          <Route index element={<Navigate to="/app/overview" replace />} />
          <Route path="overview" element={<OverviewPage />} />
          <Route path="members" element={<MembersPage />} />
          <Route path="invitations" element={<InvitationsPage />} />
          <Route path="projects" element={<ProjectsPage />} />
          <Route path="plan" element={<PlanPage />} />
          <Route path="api-keys" element={<ApiKeysPage />} />
          <Route path="audit" element={<AuditPage />} />
        </Route>
      </Route>

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
