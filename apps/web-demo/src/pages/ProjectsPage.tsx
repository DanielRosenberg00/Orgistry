import { useState } from 'react';
import type { Project } from '@orgistry/contracts';
import {
  useCreateProject,
  useDeleteProject,
  useProjects,
  useUpdateProject,
} from '../hooks/useProjects';
import { useEffectivePermissions } from '../hooks/useEffectivePermissions';
import { ErrorBanner } from '../components/ErrorBanner';
import { PermissionNote } from '../components/PermissionNote';
import {
  EmptyState,
  LoadMore,
  QueryBoundary,
} from '../components/QueryStates';
import { formatDate } from '../lib/format';

/**
 * Projects — the canonical organization-scoped resource demo: list, create,
 * rename, soft-delete, with load-more pagination. All calls are scoped to the
 * selected organization id (never an arbitrary user-supplied org). Quota
 * (`max_projects`) and permission errors come straight from the backend.
 */
export function ProjectsPage() {
  const { query, items } = useProjects();
  const permissions = useEffectivePermissions();
  const createProject = useCreateProject();
  const [name, setName] = useState('');
  const [formError, setFormError] = useState<unknown>(null);

  const canCreate = permissions.has('projects.create');
  const canUpdate = permissions.has('projects.update');
  const canDelete = permissions.has('projects.delete');

  function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    setFormError(null);
    createProject.mutate(
      { name: name.trim() },
      { onSuccess: () => setName(''), onError: setFormError },
    );
  }

  return (
    <div>
      <h1 className="page-title">Projects</h1>
      <p className="page-intro">Organization-scoped projects.</p>

      <div className="card">
        <h2>Create project</h2>
        {formError != null && <ErrorBanner error={formError} />}
        <form onSubmit={handleCreate} className="row" style={{ alignItems: 'end' }}>
          <div className="field" style={{ flex: 1, marginBottom: 0 }}>
            <label htmlFor="project-name">Name</label>
            <input
              id="project-name"
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              disabled={!canCreate}
            />
          </div>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={!canCreate || createProject.isPending}
          >
            {createProject.isPending ? 'Creating…' : 'Create project'}
          </button>
        </form>
        {!canCreate && (
          <PermissionNote>
            You do not have permission to create projects in this organization.
          </PermissionNote>
        )}
      </div>

      <div className="card">
        <h2>All projects</h2>
        <QueryBoundary isLoading={query.isLoading} error={query.error}>
          {items.length === 0 ? (
            <EmptyState>No projects yet.</EmptyState>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Created</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {items.map((project) => (
                  <ProjectRow
                    key={project.id}
                    project={project}
                    canUpdate={canUpdate}
                    canDelete={canDelete}
                  />
                ))}
              </tbody>
            </table>
          )}
          <LoadMore
            hasNextPage={query.hasNextPage}
            isFetchingNextPage={query.isFetchingNextPage}
            onClick={() => query.fetchNextPage()}
          />
        </QueryBoundary>
      </div>
    </div>
  );
}

function ProjectRow({
  project,
  canUpdate,
  canDelete,
}: {
  project: Project;
  canUpdate: boolean;
  canDelete: boolean;
}) {
  const updateProject = useUpdateProject();
  const deleteProject = useDeleteProject();
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(project.name);
  const [rowError, setRowError] = useState<unknown>(null);

  function handleSave() {
    setRowError(null);
    updateProject.mutate(
      { projectId: project.id, name: draftName.trim() },
      {
        onSuccess: () => setEditing(false),
        onError: setRowError,
      },
    );
  }

  function handleDelete() {
    if (!window.confirm(`Delete project "${project.name}"?`)) return;
    setRowError(null);
    deleteProject.mutate({ projectId: project.id }, { onError: setRowError });
  }

  return (
    <tr>
      <td>
        {editing ? (
          <input
            className="input"
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            autoFocus
          />
        ) : (
          project.name
        )}
        {rowError != null && <ErrorBanner error={rowError} />}
      </td>
      <td className="muted">{formatDate(project.createdAt)}</td>
      <td>
        <div className="row">
          {editing ? (
            <>
              <button
                className="btn btn-sm btn-primary"
                onClick={handleSave}
                disabled={updateProject.isPending || draftName.trim().length === 0}
              >
                Save
              </button>
              <button
                className="btn btn-sm"
                onClick={() => {
                  setEditing(false);
                  setDraftName(project.name);
                  setRowError(null);
                }}
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              className="btn btn-sm"
              onClick={() => setEditing(true)}
              disabled={!canUpdate}
            >
              Rename
            </button>
          )}
          <button
            className="btn btn-sm btn-danger"
            onClick={handleDelete}
            disabled={!canDelete || deleteProject.isPending}
          >
            Delete
          </button>
        </div>
      </td>
    </tr>
  );
}
