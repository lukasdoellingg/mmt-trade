/**
 * Minimal protobuf decoder for backend HeatmapFrame (proto3).
 * Matches web/backend/index.js HEATMAP_PROTO — no protobufjs on hot path.
 */

export interface HeatmapLevel {
  price: number;
  volume: number;
  isBid: boolean;
}

export interface HeatmapFrame {
  ts: number;
  levels: HeatmapLevel[];
}

const levelsScratch: HeatmapLevel[] = [];
let levelsScratchCount = 0;

function readVarint(u8: Uint8Array, start: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let off = start;
  for (let i = 0; i < 10; i++) {
    const b = u8[off++];
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value, next: off };
    shift += 7;
  }
  return { value, next: off };
}

function readDouble(u8: Uint8Array, off: number): number {
  const dv = new DataView(u8.buffer, u8.byteOffset + off, 8);
  return dv.getFloat64(0, true);
}

function writeLevel(index: number, price: number, volume: number, isBid: boolean): HeatmapLevel {
  let lv = levelsScratch[index];
  if (!lv) {
    lv = { price, volume, isBid };
    levelsScratch[index] = lv;
  } else {
    lv.price = price;
    lv.volume = volume;
    lv.isBid = isBid;
  }
  return lv;
}

function decodeLevelInto(buf: Uint8Array, index: number): HeatmapLevel {
  let off = 0;
  let price = 0;
  let volume = 0;
  let isBid = false;
  const len = buf.length;
  while (off < len) {
    const tag = buf[off++];
    const field = tag >> 3;
    const wire = tag & 7;
    if (field === 1 && wire === 1) {
      price = readDouble(buf, off);
      off += 8;
    } else if (field === 2 && wire === 1) {
      volume = readDouble(buf, off);
      off += 8;
    } else if (field === 3 && wire === 0) {
      const v = readVarint(buf, off);
      isBid = v.value !== 0;
      off = v.next;
    } else {
      break;
    }
  }
  return writeLevel(index, price, volume, isBid);
}

export function decodeHeatmapFrame(data: ArrayBuffer): HeatmapFrame | null {
  const u8 = new Uint8Array(data);
  let off = 0;
  let ts = 0;
  levelsScratchCount = 0;
  while (off < u8.length) {
    const tag = u8[off++];
    const field = tag >> 3;
    const wire = tag & 7;
    if (field === 1 && wire === 0) {
      const v = readVarint(u8, off);
      ts = v.value;
      off = v.next;
    } else if (field === 2 && wire === 2) {
      const lenV = readVarint(u8, off);
      off = lenV.next;
      const end = off + lenV.value;
      decodeLevelInto(u8.subarray(off, end), levelsScratchCount);
      levelsScratchCount += 1;
      off = end;
    } else {
      break;
    }
  }
  levelsScratch.length = levelsScratchCount;
  return { ts, levels: levelsScratch };
}
