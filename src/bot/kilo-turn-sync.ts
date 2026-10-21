import { startNativeTurnSync, type NativeTurnSyncDeps } from './native-turn-sync';

export type KiloTurnSyncDeps = Omit<NativeTurnSyncDeps, 'toolId' | 'displayName'>;
export function startKiloTurnSync(deps: KiloTurnSyncDeps) {
  return startNativeTurnSync({ ...deps, toolId: 'kilo', displayName: 'Kilo' });
}
