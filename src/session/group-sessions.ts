import type { AgentKind } from '../config/profile-schema';
import type { SessionCatalog } from './catalog';
import { isPersonalWorkgroup, type ToolBinding, type ToolBindingStore } from '../tools/bindings';

/** Existing workgroups and active auxiliary groups define the Web/picker scope. */
export function groupSessionBindings(bindings?: ToolBindingStore,
  groups: { chatId: string; status: string; source?: { toolId: AgentKind; sourceId: string; nativeId: string } }[] = [],
  catalog?: SessionCatalog): [string, ToolBinding][] {
  if (!bindings) return [];
  const personal = bindings.activePersonalBindings();
  const scopes = new Set(personal.map(([scope]) => scope));
  const pending = bindings.entries().filter(([scope, b]) => !scopes.has(scope) && b.nativeCreated === false && isPersonalWorkgroup(scope, b));
  const shared: [string, ToolBinding][] = groups.flatMap(row => {
    const b = bindings.get(row.chatId);
    return row.status === 'active' && row.source && b?.sharedScope && b.nativeId === row.source.nativeId &&
      b.toolId === row.source.toolId && b.sourceId === row.source.sourceId ? [[row.chatId, b] as [string, ToolBinding]] : [];
  });
  return [...personal, ...pending, ...shared].filter(([scope, b]) => !catalog?.isScopeArchived(scope) && !catalog?.isChatDissolved(scope) &&
    (!b.nativeId || !bindings.isArchived(b.toolId, b.sourceId, b.nativeId) && !catalog?.isThreadArchived(b.nativeId)));
}
