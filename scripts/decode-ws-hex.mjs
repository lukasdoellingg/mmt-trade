#!/usr/bin/env node
/**
 * Decode pasted WebSocket hex (MMT CBOR or our HeatmapFrame protobuf).
 * Usage: node scripts/decode-ws-hex.mjs <hex> [--json]
 */
const hex = process.argv[2]?.replace(/\s/g, '');
if (!hex) {
  console.error('Usage: node scripts/decode-ws-hex.mjs <hex>');
  process.exit(1);
}
const buf = Buffer.from(hex, 'hex');
console.log('bytes', buf.length);

function decodeAny(buf, off = 0) {
  const b = buf[off];
  const major = b >> 5;
  const ai = b & 0x1f;
  off++;
  if (major === 4) {
    let count = ai;
    let o = off;
    if (ai === 24) count = buf[o++];
    const items = [];
    for (let i = 0; i < count; i++) {
      const r = decodeAny(buf, o);
      items.push(r.val);
      o = r.off;
    }
    return { val: items, off: o };
  }
  if (major === 5) {
    let count = ai;
    let o = off;
    if (ai === 24) count = buf[o++];
    const obj = {};
    for (let i = 0; i < count; i++) {
      const kr = decodeAny(buf, o);
      o = kr.off;
      const vr = decodeAny(buf, o);
      o = vr.off;
      obj[String(kr.val)] = vr.val;
    }
    return { val: obj, off: o };
  }
  if (major === 2) {
    let count = ai;
    let o = off;
    if (ai === 24) count = buf[o++];
    const slice = buf.subarray(o, o + count);
    let nested = null;
    try {
      if (slice[0] >= 0xa0 || slice[0] === 0xbf || (slice[0] >> 5) <= 5) {
        nested = decodeAny(slice, 0).val;
      }
    } catch { /* ignore */ }
    return {
      val: nested ?? { _bytes: slice.toString('hex'), len: count },
      off: o + count,
    };
  }
  if (major === 3) {
    let count = ai;
    let o = off;
    if (ai === 24) count = buf[o++];
    return { val: buf.toString('utf8', o, o + count), off: o + count };
  }
  if (major === 0) {
    let n = ai;
    let o = off;
    if (ai === 24) n = buf[o++];
    else if (ai === 25) {
      n = buf.readUInt16BE(o);
      o += 2;
    } else if (ai === 26) {
      n = buf.readUInt32BE(o);
      o += 4;
    } else if (ai < 24) return { val: n, off };
    return { val: n, off: o };
  }
  if (major === 1) {
    let n = ai;
    let o = off;
    if (ai === 24) n = buf[o++];
    return { val: -1 - n, off: o };
  }
  if (major === 7 && ai === 27) return { val: buf.readDoubleBE(off), off: off + 8 };
  if (major === 7 && ai === 26) return { val: buf.readFloat32BE(off), off: off + 4 };
  if (major === 7 && ai === 21) return { val: false, off };
  if (major === 7 && ai === 20) return { val: true, off };
  if (major === 7 && ai === 22) return { val: null, off };
  return { val: { _cbor: { major, ai } }, off };
}

function tryCbor() {
  try {
    const r = decodeAny(buf, 0);
    return r;
  } catch {
    return null;
  }
}

function tryProtobuf() {
  let off = 0;
  let ts = 0;
  const levels = [];
  const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const readVarint = (start) => {
    let value = 0;
    let shift = 0;
    let o = start;
    for (let i = 0; i < 10; i++) {
      const b = u8[o++];
      value |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return { value, next: o };
      shift += 7;
    }
    return { value, next: o };
  };
  while (off < u8.length) {
    const tag = u8[off++];
    const field = tag >> 3;
    const wire = tag & 7;
    if (field === 1 && wire === 0) {
      const v = readVarint(off);
      ts = v.value;
      off = v.next;
    } else if (field === 2 && wire === 2) {
      const lenV = readVarint(off);
      off = lenV.next;
      levels.push({ _raw: buf.subarray(off, off + lenV.value).toString('hex') });
      off += lenV.value;
    } else {
      return null;
    }
  }
  return { ts, levels: levels.length };
}

const cbor = tryCbor();
const proto = tryProtobuf();

console.log('\n--- CBOR (best effort) ---');
if (cbor) console.log(JSON.stringify(cbor.val, null, 2));
else console.log('(not CBOR)');

console.log('\n--- Protobuf HeatmapFrame (471 backend) ---');
if (proto) console.log(JSON.stringify(proto, null, 2));
else console.log('(not our HeatmapFrame)');

if (process.argv.includes('--json') && cbor) {
  process.stdout.write('\n');
}
