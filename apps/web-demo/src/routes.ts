import type { ComponentType } from 'react';
import { FoundationStatusPage } from './pages/FoundationStatusPage';

/**
 * Route registry.
 *
 * A flat path -> component map is enough for the Sprint 1 shell. It establishes
 * where feature routes will be registered later without pulling in a router
 * dependency before there are real screens to route between.
 */
export interface RouteDefinition {
  path: string;
  component: ComponentType;
}

export const routes: RouteDefinition[] = [
  { path: '/', component: FoundationStatusPage },
];
