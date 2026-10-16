import { toolDefinition, type ToolId } from '../tools/definitions';
import type { AccessMode } from '../config/permissions';
import type { ProfileConfig } from '../config/profile-schema';

export type AgentCapabilityId = ToolId;
export type AgentSessionKind = ReturnType<typeof toolDefinition>['sessionKind'];
export type PromptInjectionMode = 'none';

export interface AgentCapability {
  agentId: AgentCapabilityId;
  sessionKind: AgentSessionKind;
  promptInjection: PromptInjectionMode;
  systemPrompt: string;
  supportsNativeHistory: boolean;
  callback: {
    marker: '__bridge_cb';
    legacyMarkers: string[];
  };
  permissions: {
    maxAccess: AccessMode;
  };
}

export function capabilityForTool(id: ToolId, profile?: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  const definition = toolDefinition(id);
  return { agentId: id, sessionKind: definition.sessionKind, promptInjection: definition.promptInjection,
    systemPrompt: '', supportsNativeHistory: definition.nativeHistory,
    callback: { marker: '__bridge_cb', legacyMarkers: [...definition.legacyMarkers] },
    permissions: { maxAccess: profile?.permissions.maxAccess ?? 'full' } };
}
/** Compatibility exports for existing embedders. */
export function claudeCapability(profile?: Pick<ProfileConfig, 'permissions'>): AgentCapability { return capabilityForTool('claude', profile); }
export function codexCapability(profile: Pick<ProfileConfig, 'permissions'>): AgentCapability { return capabilityForTool('codex', profile); }
