import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { ToolBinding } from '../tools/bindings';
import type { AgentTool, ToolSession } from '../tools/types';
import { writeFileAtomic } from '../platform/atomic-write';
import { namedSession } from '../session/display-name';
export interface WebRoute extends ToolBinding {
  nativeId: string;
  cwd: string;
  archived?: boolean;
}
export const isWebScope = (scope: string): boolean => /^web:[a-f0-9]{64}$/.test(scope);
/** Native identity directory, separate from all Feishu group bindings. */
export class WebRoutes {
  private routes: Record<string, WebRoute> = {};
  private dirty = false;
  private saving: Promise<void> = Promise.resolve();
  constructor(
    private path: string,
    private profile: string,
    private appId: string,
  ) {}
  scope(binding: Pick<WebRoute, 'toolId' | 'sourceId' | 'nativeId'>) {
    return (
      'web:' +
      createHash('sha256')
        .update(
          JSON.stringify([
            this.profile,
            this.appId,
            binding.toolId,
            binding.sourceId,
            binding.nativeId,
          ]),
        )
        .digest('hex')
    );
  }
  async load() {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8'));
      if (value.version !== 1 || value.profile !== this.profile || value.appId !== this.appId)
        return;
      if (!value.routes || Array.isArray(value.routes)) throw Error('Invalid Web route directory');
      for (const [scope, b] of Object.entries(value.routes) as [string, WebRoute][]) {
        if (scope !== this.scope(b) || !b.nativeId || !b.sourceId || typeof b.cwd !== 'string')
          throw Error('Invalid native Web identity');
      }
      this.routes = value.routes;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  get(scope: string): WebRoute | undefined {
    const r = this.routes[scope];
    return r ? structuredClone(r) : undefined;
  }
  entries(): [string, WebRoute][] {
    return Object.entries(this.routes).map(([s, b]) => [s, structuredClone(b)]);
  }
  ensure(tool: Pick<AgentTool, 'id' | 'sourceId'>, row: ToolSession) {
    const base = { toolId: tool.id, sourceId: tool.sourceId, nativeId: row.nativeId };
    const scope = this.scope(base),
      old = this.routes[scope];
    this.set(scope, {
      ...old,
      ...base,
      cwd: old?.cwd || row.cwd,
      name: namedSession(row.nativeId, row.name, old?.name),
      nativeCreated: true,
      archived: row.archived === true,
      createdAtMs: old?.createdAtMs ?? row.createdAtMs,
    });
    return scope;
  }
  set(scope: string, binding: ToolBinding & Partial<Pick<WebRoute, 'cwd' | 'archived'>>) {
    if (!binding.nativeId || scope !== this.scope({ ...binding, nativeId: binding.nativeId }))
      throw Error('Native Web identity cannot be changed');
    const row = { ...this.routes[scope], ...binding } as WebRoute;
    if (typeof row.cwd !== 'string') throw Error('Native working directory missing');
    if (JSON.stringify(row) !== JSON.stringify(this.routes[scope])) {
      this.routes[scope] = structuredClone(row);
      this.dirty = true;
    }
  }
  flush(): Promise<void> {
    if (this.dirty) {
      this.dirty = false;
      const data =
        JSON.stringify({
          version: 1,
          profile: this.profile,
          appId: this.appId,
          routes: this.routes,
        }) + '\n';
      this.saving = this.saving.catch(() => {}).then(() => writeFileAtomic(this.path, data,{mode:0o600})).catch(error=>{this.dirty=true;throw error;});
    }
    return this.saving;
  }
}
