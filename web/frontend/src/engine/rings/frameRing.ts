/** SAB-compatible frame ring (mirrors packages/engine/src/data/frame_ring.odin). */
export const FRAME_RING_CAPACITY = 8;
export const MAX_FRAME_BYTES = 256 * 1024;

export class FrameRing {
  readonly rawBytes: Uint8Array;
  readonly frameLengths: Uint32Array;
  headIndex = 0;
  tailIndex = 0;

  constructor() {
    this.rawBytes = new Uint8Array(FRAME_RING_CAPACITY * MAX_FRAME_BYTES);
    this.frameLengths = new Uint32Array(FRAME_RING_CAPACITY);
  }

  push(payload: Uint8Array): boolean {
    if (payload.length === 0 || payload.length > MAX_FRAME_BYTES) return false;
    const nextTail = (this.tailIndex + 1) % FRAME_RING_CAPACITY;
    if (nextTail === this.headIndex) return false;
    const slot = this.tailIndex % FRAME_RING_CAPACITY;
    const offset = slot * MAX_FRAME_BYTES;
    this.rawBytes.set(payload, offset);
    this.frameLengths[slot] = payload.length;
    this.tailIndex = nextTail;
    return true;
  }

  pop(): Uint8Array | null {
    if (this.headIndex === this.tailIndex) return null;
    const slot = this.headIndex % FRAME_RING_CAPACITY;
    const len = this.frameLengths[slot];
    const offset = slot * MAX_FRAME_BYTES;
    this.frameLengths[slot] = 0;
    this.headIndex = (this.headIndex + 1) % FRAME_RING_CAPACITY;
    return this.rawBytes.subarray(offset, offset + len);
  }
}
