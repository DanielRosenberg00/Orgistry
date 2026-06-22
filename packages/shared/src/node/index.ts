// Node-only entrypoint for `@orgistry/shared`. Keep this barrel limited to
// utilities that depend on Node built-ins so the main entrypoint stays
// general/browser-safe.
export { findWorkspaceRoot, loadWorkspaceEnv } from './load-env';
