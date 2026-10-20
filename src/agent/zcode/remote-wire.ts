/** ZCode's public Channel RPC wire format (packages/rpc) and relay framing.
 * Interoperability implementation; see docs/ZCODE.md for upstream references.
 */
const MAX_MESSAGE = 16 * 1024 * 1024;
const MAX_FRAME = 1024 * 1024;

function integer(n: number): Buffer {
  const bytes: number[] = [];
  do { bytes.push((n & 127) | (n >>> 7 ? 128 : 0)); n >>>= 7; } while (n);
  return Buffer.from(bytes);
}
function encode(value: any, depth = 0): Buffer {
  if (depth > 64) throw new Error('ZCode RPC nesting limit');
  if (value === undefined) return Buffer.from([0]);
  if (Number.isInteger(value) && value >= 0 && value <= 0x7fffffff) return Buffer.concat([Buffer.from([6]), integer(value)]);
  if (Array.isArray(value)) return Buffer.concat([Buffer.from([4]), integer(value.length), ...value.map(row => encode(row, depth + 1))]);
  const kind = typeof value === 'string' ? 1 : value instanceof Uint8Array ? 2 : 5;
  const bytes = kind === 2 ? Buffer.from(value) : Buffer.from(kind === 1 ? value : JSON.stringify(value));
  return Buffer.concat([Buffer.from([kind]), integer(bytes.length), bytes]);
}
export function encodeRpc(header: unknown[], body?: unknown): Buffer {
  const bytes = Buffer.concat([encode(header), encode(body)]);
  if (bytes.length > MAX_MESSAGE) throw new Error('ZCode RPC message too large');
  return bytes;
}
export function decodeRpc(bytes: Buffer): { header: any[]; body: any } {
  if (bytes.length > MAX_MESSAGE) throw new Error('ZCode RPC message too large');
  let pos = 0;
  function take(n: number): Buffer {
    if (n < 0 || pos + n > bytes.length) throw new Error('Truncated ZCode RPC');
    const value = bytes.subarray(pos, pos + n); pos += n; return value;
  }
  function number(): number {
    let n = 0;
    for (let i = 0; i < 5; i++) { const b = take(1)[0]!; n += (b & 127) * 2 ** (7 * i); if (!(b & 128)) return n; }
    throw new Error('Invalid ZCode RPC length');
  }
  function read(depth = 0): any {
    if (depth > 64) throw new Error('ZCode RPC nesting limit');
    const kind = take(1)[0];
    if (kind === 0) return undefined;
    if (kind === 6) return number();
    const n = number();
    if (kind === 4) {
      if (n > bytes.length - pos) throw new Error('Invalid ZCode RPC array');
      return Array.from({ length: n }, () => read(depth + 1));
    }
    const data = take(n);
    if (kind === 1) return data.toString('utf8');
    if (kind === 2 || kind === 3) return data;
    if (kind === 5) return JSON.parse(data.toString('utf8'));
    throw new Error('Invalid ZCode RPC type');
  }
  const header = read(), body = read();
  if (!Array.isArray(header) || pos !== bytes.length) throw new Error('Invalid ZCode RPC envelope');
  return { header, body };
}
export function crc32(bytes: Uint8Array): string {
  let n = 0xffffffff;
  for (const b of bytes) { n ^= b; for (let i = 0; i < 8; i++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0); }
  return ((n ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}
export class RemoteFrames {
  private outSeq = 0;
  private outMessage = 0;
  private inSeq = 1;
  private inMessage = 1;
  private active?: { message: number; count: number; size: number; checksum: string; parts: Buffer[]; bytes: number; started: number };
  constructor(readonly bridgeSessionId: string) {}
  encode(bytes: Buffer): any[] {
    if (!bytes.length || bytes.length > MAX_MESSAGE) throw new Error('ZCode relay message too large');
    const count = Math.ceil(bytes.length / (512 * 1024)), messageSeq = ++this.outMessage, checksum = crc32(bytes);
    return Array.from({ length: count }, (_, i) => ({ zcode_type: 'rpc-frame', bridgeSessionId: this.bridgeSessionId,
      seq: ++this.outSeq, messageSeq, fragmentIndex: i, fragmentCount: count, messageBytes: bytes.length,
      checksum: { algorithm: 'crc32', value: checksum }, dataBase64: bytes.subarray(i * 512 * 1024, (i + 1) * 512 * 1024).toString('base64') }));
  }
  accept(frame: any): { bytes?: Buffer; ack?: any } {
    if (frame.bridgeSessionId !== this.bridgeSessionId) return {};
    if (frame.zcode_type === 'rpc-frame-ack') return {};
    if (JSON.stringify(frame).length > MAX_FRAME || !Number.isSafeInteger(frame.seq) || frame.seq < 1) throw new Error('Invalid ZCode relay frame');
    if (frame.seq < this.inSeq) return { ack: this.inMessage > 1 ? this.ack(this.inMessage - 1) : undefined };
    if (frame.seq !== this.inSeq) throw new Error('ZCode relay frame gap; execution status may be unknown');
    if (frame.messageSeq !== this.inMessage || !Number.isSafeInteger(frame.fragmentCount) || frame.fragmentCount < 1 || frame.fragmentCount > 64 ||
        !Number.isSafeInteger(frame.messageBytes) || frame.messageBytes < 1 || frame.messageBytes > MAX_MESSAGE ||
        frame.checksum?.algorithm !== 'crc32' || !/^[a-f0-9]{8}$/.test(frame.checksum.value) || typeof frame.dataBase64 !== 'string') throw new Error('Invalid ZCode relay fragment');
    const data = Buffer.from(frame.dataBase64, 'base64');
    if (!data.length || data.toString('base64') !== frame.dataBase64) throw new Error('Invalid ZCode relay base64');
    this.active ??= { message: frame.messageSeq, count: frame.fragmentCount, size: frame.messageBytes, checksum: frame.checksum.value, parts: [], bytes: 0, started: Date.now() };
    const a = this.active;
    if (Date.now() - a.started > 30_000 || a.count !== frame.fragmentCount || a.size !== frame.messageBytes || a.checksum !== frame.checksum.value || frame.fragmentIndex !== a.parts.length || a.bytes + data.length > a.size) throw new Error('Inconsistent ZCode relay fragments');
    a.parts.push(data); a.bytes += data.length; this.inSeq++;
    if (a.parts.length < a.count) return {};
    const bytes = Buffer.concat(a.parts);
    if (a.bytes !== a.size || crc32(bytes) !== a.checksum) throw new Error('ZCode relay checksum mismatch');
    this.active = undefined; this.inMessage++;
    return { bytes, ack: this.ack(frame.messageSeq) };
  }
  private ack(ackMessageSeq: number) { return { zcode_type: 'rpc-frame-ack', bridgeSessionId: this.bridgeSessionId, ackMessageSeq }; }
}
