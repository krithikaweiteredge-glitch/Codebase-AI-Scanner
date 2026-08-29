import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from '@/components/layout/AppShell';
import { Spinner } from '@/components/ui/primitives';
import { useAuth } from '@/hooks/useAuth';
import { ArchitecturePage } from '@/pages/ArchitecturePage';
import { ChatPage } from '@/pages/ChatPage';
import { CodeExplorerPage } from '@/pages/CodeExplorerPage';
import { ConnectRepositoryPage } from '@/pages/ConnectRepositoryPage';
import { DashboardPage } from '@/pages/DashboardPage';
import { DocumentationPage } from '@/pages/DocumentationPage';
import { FindingsPage } from '@/pages/FindingsPage';
import { LoginPage } from '@/pages/LoginPage';
import { PullRequestDetailPage } from '@/pages/PullRequestDetailPage';
import { PullRequestsPage } from '@/pages/PullRequestsPage';
import { RepositoriesPage } from '@/pages/RepositoriesPage';
import { RepositoryOverviewPage } from '@/pages/RepositoryOverviewPage';
import { SearchPage } from '@/pages/SearchPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { TestsPage } from '@/pages/TestsPage';

export function App() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="h-5 w-5 text-accent" />
      </div>
    );
  }

  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route element={<AppShell />}>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/repositories" element={<RepositoriesPage />} />
        <Route path="/repositories/connect" element={<ConnectRepositoryPage />} />
        <Route path="/repositories/:repositoryId" element={<RepositoryOverviewPage />} />
        <Route path="/repositories/:repositoryId/explorer" element={<CodeExplorerPage />} />
        <Route path="/repositories/:repositoryId/chat" element={<ChatPage />} />
        <Route path="/repositories/:repositoryId/search" element={<SearchPage />} />
        <Route
          path="/repositories/:repositoryId/security"
          element={
            <FindingsPage
              endpoint="security"
              title="Security"
              description="Static rules and secret scanning first; AI review adds reasoning on the highest-risk files. Every finding cites real code."
              emptyMessage="No security findings on the indexed branch. Static rules, secret scanning and (when configured) AI review all came back clean."
            />
          }
        />
        <Route
          path="/repositories/:repositoryId/bugs"
          element={
            <FindingsPage
              endpoint="bugs"
              title="Bug Analysis"
              description="Defects with a concrete failing scenario. Confirmed findings come from deterministic detectors; potential ones from AI reasoning."
              emptyMessage="No potential defects were detected on the indexed branch."
            />
          }
        />
        <Route
          path="/repositories/:repositoryId/performance"
          element={
            <FindingsPage
              endpoint="performance"
              title="Performance"
              description="N+1 queries, unbounded reads, blocking work and render-path costs, located in the actual code."
              emptyMessage="No performance problems were detected on the indexed branch."
            />
          }
        />
        <Route
          path="/repositories/:repositoryId/duplicates"
          element={
            <FindingsPage
              endpoint="duplicates"
              title="Duplicate & Unnecessary Code"
              description="Token-shingle similarity across every indexed symbol, plus dead files, unused imports and unreachable code."
              emptyMessage="No duplicated or unused code was detected on the indexed branch."
            />
          }
        />
        <Route path="/repositories/:repositoryId/pull-requests" element={<PullRequestsPage />} />
        <Route path="/repositories/:repositoryId/pull-requests/:number" element={<PullRequestDetailPage />} />
        <Route path="/repositories/:repositoryId/tests" element={<TestsPage />} />
        <Route path="/repositories/:repositoryId/docs" element={<DocumentationPage />} />
        <Route path="/repositories/:repositoryId/architecture" element={<ArchitecturePage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
