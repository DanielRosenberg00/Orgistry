import { Navigate, Route, Routes } from 'react-router-dom';
import { ProtectedRoute } from './components/ProtectedRoute';
import { AppShell } from './components/AppShell';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { CompleteRegistrationPage } from './pages/CompleteRegistrationPage';
import { InvitationPage } from './pages/InvitationPage';
import { VerifyEmailPage } from './pages/VerifyEmailPage';
import { ForgotPasswordPage } from './pages/ForgotPasswordPage';
import { ResetPasswordPage } from './pages/ResetPasswordPage';
import { AccountSecurityPage } from './pages/AccountSecurityPage';
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
 *   /auth/login, /auth/register   — public auth screens (register only
 *                                   REQUESTS a registration — Sprint 18)
 *   /auth/complete-registration   — public registration-completion page
 *                                   (target of the emailed link; creates the
 *                                   account and signs the user in)
 *   /auth/forgot-password         — public password-recovery request page
 *   /auth/reset-password          — public reset-completion page (target of
 *                                   the emailed link)
 *   /auth/verify-email            — public email-verification completion page
 *                                   (target of the emailed link; works signed
 *                                   in or out)
 *   /invitations/accept           — public invitation landing page (target of
 *                                   the invitation email; inspects the token,
 *                                   then accepts as an existing user or hands
 *                                   safe context to registration)
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
      <Route
        path="/auth/complete-registration"
        element={<CompleteRegistrationPage />}
      />
      <Route path="/auth/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/auth/reset-password" element={<ResetPasswordPage />} />
      <Route path="/auth/verify-email" element={<VerifyEmailPage />} />
      <Route path="/invitations/accept" element={<InvitationPage />} />

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
          <Route path="account" element={<AccountSecurityPage />} />
        </Route>
      </Route>

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
