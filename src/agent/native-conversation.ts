import type { RunState } from '../card/run-state';

/** A read-only view of a native tool conversation; never an execution request. */
export interface NativeConversationTurn {
  id: string;
  createdAtMs: number;
  /** True also for unknown provenance: only confirmed native input may be mirrored. */
  bridge: boolean;
  input: string;
  state: RunState;
}
export interface NativeConversationSnapshot {
  id: string;
  name?: string;
  cwd: string;
  archived: boolean;
  turns: NativeConversationTurn[];
}
export interface NativeConversationReader {
  read(id: string): Promise<NativeConversationSnapshot>;
  stopTurn?(id: string, turnId: string): Promise<boolean>;
  close(): Promise<void>;
}
