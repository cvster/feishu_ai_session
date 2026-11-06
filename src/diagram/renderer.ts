import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { resolve as resolveModule } from 'import-meta-resolve';
import type { Token } from 'marked';
import { diagramWorkerSource } from './worker-source';

export interface DiagramImage { svg: string; png: Buffer }
type Entry = { source: string; image?: DiagramImage; pending?: Promise<DiagramImage>; failed?: boolean };

/** Closed fences only: streaming snippets must stay literal until complete. */
export function mermaidSource(token: Token): string | undefined {
  if (token.type !== 'code' || token.lang?.trim().toLowerCase() !== 'mermaid') return;
  const opening = /^[ \t]*(`{3,}|~{3,})[^\n]*\n/.exec(token.raw);
  if (!opening) return;
  const fence = opening[1]!;
  if (!new RegExp('\\n[ \\t]*' + fence[0] + '{' + fence.length + ',}[ \\t]*(?:\\n)?$').test(token.raw)) return;
  return token.text;
}

/** Bounded in-memory cache shared by Web and Feishu, with no remote renderer. */
export class DiagramStore {
  private entries = new Map<string, Entry>();
  private active = 0;
  private waiters: (() => void)[] = [];
  constructor(private timeoutMs = 10_000) {}
  register(source: string): string | undefined {
    const plain = source.replace(/<br\s*\/?>/gi, '').replace(/<\/?(?:sub|sup|small|mark)\s*>/gi, '');
    if (source.length > 16_000 || source.split('\n').length > 200 ||
      !/^\s*(?:(?:%%[^\n]*\n)\s*)*(?:flowchart\s|graph\s|stateDiagram(?:-v2)?\b|sequenceDiagram\b|classDiagram\b|erDiagram\b|xychart(?:-beta)?\b)/i.test(source) ||
      /%%\{|<\/?[A-Za-z!]|^\s*(?:click|style|classDef|linkStyle)\s|(?:url\s*\(|javascript:|@import)/im.test(plain)) return;
    const id = createHash('sha256').update('beautiful-mermaid-1.1.3-static-v1\0' + source).digest('hex');
    const entry = this.entries.get(id) ?? { source };
    this.entries.delete(id); this.entries.set(id, entry);
    this.trim(); return id;
  }
  source(id: string): string | undefined { return this.entries.get(id)?.source; }
  private trim() {
    let bytes = [...this.entries.values()].reduce((n, e) => n + e.source.length * 2 + (e.image ? e.image.svg.length * 2 + e.image.png.length : 0), 0);
    for (const [id, entry] of this.entries) {
      if (this.entries.size <= 256 && bytes <= 32 * 1024 * 1024) break;
      if (entry.pending) continue;
      this.entries.delete(id);
      bytes -= entry.source.length * 2 + (entry.image ? entry.image.svg.length * 2 + entry.image.png.length : 0);
    }
  }
  async render(id: string): Promise<DiagramImage> {
    const entry = this.entries.get(id);
    if (!entry) throw Error('Diagram not found');
    if (entry.image) return entry.image;
    if (entry.failed) throw Error('Diagram unavailable');
    if (entry.pending) return entry.pending;
    if (this.active >= 2 && this.waiters.length >= 8) throw Error('Diagram renderer busy');
    entry.pending = this.run(entry.source);
    try { entry.image = await entry.pending; return entry.image; }
    catch (error) { entry.failed = true; throw error; }
    finally { entry.pending = undefined; this.trim(); }
  }
  private async run(source: string): Promise<DiagramImage> {
    if (this.active >= 2) await new Promise<void>(resolve => this.waiters.push(resolve));
    else this.active++;
    try {
      return await new Promise<DiagramImage>((resolve, reject) => {
        const worker = new Worker(diagramWorkerSource, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 256 }, workerData: {
          source, mermaid: resolveModule('beautiful-mermaid', import.meta.url), resvg: resolveModule('@resvg/resvg-js', import.meta.url), saxes: resolveModule('saxes', import.meta.url),
        } });
        const timer = setTimeout(() => { reject(Error('Diagram rendering timed out')); void worker.terminate(); }, this.timeoutMs);
        worker.once('message', (result: { svg?: string; png?: Uint8Array; error?: boolean }) => {
          clearTimeout(timer); void worker.terminate();
          if (!result.svg || !result.png || result.error) reject(Error('Diagram rendering failed'));
          else resolve({ svg: result.svg, png: Buffer.from(result.png) });
        });
        worker.once('error', error => { clearTimeout(timer); reject(error); });
        worker.once('exit', () => { clearTimeout(timer); reject(Error('Diagram renderer exited')); });
      });
    } finally { const next = this.waiters.shift(); if (next) next(); else this.active--; }
  }
}
export const diagrams = new DiagramStore();
