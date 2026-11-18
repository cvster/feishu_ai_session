import { createHash } from 'node:crypto';
import { isPersonalWorkgroup, sessionRefKey, type ToolBinding } from '../tools/bindings';

/** Enumerate existing shared routes and stable, lazy routes for personal sessions. */
export function a2aSessionBindings(entries: [string, ToolBinding][]): [string, ToolBinding][] {
  const shared = entries.filter(([, b]) => b.linkedSource && !b.sharedScope);
  const sources = new Set(shared.map(([, b]) => sessionRefKey(b.linkedSource!.toolId, b.linkedSource!.sourceId, b.linkedSource!.nativeId)));
  for (const [scope, b] of entries) {
    if (!isPersonalWorkgroup(scope, b) || !b.nativeId || b.nativeCreated === false) continue;
    const key = sessionRefKey(b.toolId, b.sourceId, b.nativeId);
    if (sources.has(key)) continue;
    sources.add(key);
    shared.push([`aux_${createHash('sha256').update(key).digest('hex').slice(0, 32)}`, {
      toolId: b.toolId, sourceId: b.sourceId, nativeId: b.nativeId, nativeCreated: true,
      name: b.name, model: b.model, reasoningEffort: b.reasoningEffort,
      linkedSource: { toolId: b.toolId, sourceId: b.sourceId, nativeId: b.nativeId },
    }]);
  }
  return shared;
}
