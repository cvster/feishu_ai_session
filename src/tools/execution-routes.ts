import type { Controls } from '../commands';
import type { ToolBinding } from './bindings';
import { isWebScope } from '../web/routes';
export function executionBinding(controls: Controls, scope: string): ToolBinding | undefined {
  return isWebScope(scope) ? controls.webRoutes?.get(scope) : controls.toolBindings?.get(scope);
}
export function setExecutionBinding(controls: Controls, scope: string, binding: ToolBinding): void {
  if (isWebScope(scope)) controls.webRoutes?.set(scope, binding);
  else controls.toolBindings?.set(scope, binding);
}
