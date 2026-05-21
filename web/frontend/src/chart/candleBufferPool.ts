/**
 * Rotating pool for Float64Array buffers transferred via postMessage.
 *
 * Transferred ArrayBuffers are neutered on the sender side; this pool
 * re-allocates emptied slots on the next acquire so pan/zoom time-axis
 * sync avoids per-frame `new Float64Array`.
 */
export function createTransferredFloat64Pool(maxFloats: number, depth = 3) {
  const slots: Float64Array[] = [];
  for (let i = 0; i < depth; i++) slots.push(new Float64Array(maxFloats));
  let rot = -1;

  return {
    copyForTransfer(src: Float64Array, floatCount: number): Float64Array {
      rot = (rot + 1) % depth;
      let buf = slots[rot];
      if (buf.buffer.byteLength === 0) buf = slots[rot] = new Float64Array(maxFloats);
      buf.set(src.subarray(0, floatCount));
      return buf.subarray(0, floatCount);
    },
  };
}
