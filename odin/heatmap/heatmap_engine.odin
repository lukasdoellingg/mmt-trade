package heatmap_engine

// ═══════════════════════════════════════════════════════════════
//  Heatmap Engine — Odin → WASM (freestanding, js_wasm32)
//
//  Purpose:
//    - Parse binary Protobuf HeatmapFrame payloads:
//        message HeatmapLevel { double price = 1; double volume = 2; bool isBid = 3; }
//        message HeatmapFrame  { int64 ts = 1; repeated HeatmapLevel levels = 2; }
//    - Downsample levels to a compact vertex buffer for WebGL.
//    - Expose the vertex buffer as a packed Float32Array:
//        [xNorm, price, signedVolume] per vertex
//      where signedVolume > 0 for bids, < 0 for asks.
//
//  Design:
//    - Static global buffers only (no heap, no GC).
//    - SoA → interleaved AoS at the very end for GPU upload.
//    - Intended to be used from JS/TS via:
//        - get_input_offset() / get_input_capacity()
//        - get_heatmap_vertices_offset() / get_heatmap_vertex_count()
//        - process_heatmap_payload(ptr, len)
// ═══════════════════════════════════════════════════════════════

// Limits (tune as needed)
// MAX_LEVELS: Obergrenze für Eingangs-Levels UND Ausgabevertices.
// Wir halten Input/Output symmetrisch, um Fragmentierung zu vermeiden.
MAX_LEVELS   :: 2000;
VERT_STRIDE  :: 3;        // [xNorm, price, signedVolume]

INPUT_CAP_BYTES :: 64 * 1024; // 64 KiB protobuf payload cap

// ── Static buffers ─────────────────────────────────────────────

// Raw input scratch (JS writes here using get_input_offset)
heatmap_input: [INPUT_CAP_BYTES]u8;

// Parsed levels (SoA)
in_prices: [MAX_LEVELS]f64;
in_volumes: [MAX_LEVELS]f64;
in_signed: [MAX_LEVELS]f32; // +vol for bids, -vol for asks

// Output vertices for WebGL (AoS, packed)
heatmap_vertices: [MAX_LEVELS * VERT_STRIDE]f32;
heatmap_vertex_count: i32;

// ── Small helpers ──────────────────────────────────────────────

@(private)
clamp_i32 :: proc "contextless" (v, lo, hi: i32) -> i32 {
    if v < lo { return lo; }
    if v > hi { return hi; }
    return v;
}

// Read protobuf varint (up to 64-bit). Returns value; idx advanced.
@(private)
read_varint :: proc "contextless" (data: [^]u8, len: i32, idx: ^i32) -> u64 {
    v: u64 = 0;
    shift: u32 = 0;
    i := idx^;
    for shift < 64 && i < len {
        b := data[i];
        i += 1;
        v |= u64(b & 0x7F) << shift;
        if (b & 0x80) == 0 {
            idx^ = i;
            return v;
        }
        shift += 7;
    }
    idx^ = i;
    return v;
}

// Read 64‑bit little-endian value and reinterpret as f64.
@(private)
read_f64_le :: proc "contextless" (data: [^]u8, len: i32, idx: ^i32) -> f64 {
    i := idx^;
    if i + 8 > len {
        idx^ = len;
        return 0.0;
    }
    v: u64 = 0;
    v |= u64(data[i+0]) << 0;
    v |= u64(data[i+1]) << 8;
    v |= u64(data[i+2]) << 16;
    v |= u64(data[i+3]) << 24;
    v |= u64(data[i+4]) << 32;
    v |= u64(data[i+5]) << 40;
    v |= u64(data[i+6]) << 48;
    v |= u64(data[i+7]) << 56;
    idx^ = i + 8;
    return transmute(f64) v;
}

// Skip unknown protobuf field by wire type.
@(private)
skip_field :: proc "contextless" (wire_type: u64, data: [^]u8, len: i32, idx: ^i32) {
    i := idx^;
    when true {
        if wire_type == 0 { // varint
            // reuse read_varint
            _ = read_varint(data, len, &i);
        } else if wire_type == 1 { // 64‑bit
            if i + 8 > len { i = len; }
            else i += 8;
        } else if wire_type == 2 { // length-delimited
            l := read_varint(data, len, &i);
            if i + i32(l) > len { i = len; }
            else i += i32(l);
        } else if wire_type == 5 { // 32‑bit
            if i + 4 > len { i = len; }
            else i += 4;
        } else {
            // unsupported type — bail out
            i = len;
        }
    }
    idx^ = i;
}

// Parse one HeatmapLevel message between [start, end).
@(private)
parse_level :: proc "contextless" (data: [^]u8, start, end: i32, price: ^f64, volume: ^f64, signed: ^f32) {
    p := start;
    pr: f64 = 0.0;
    vol: f64 = 0.0;
    is_bid: f32 = 0.0;

    for p < end {
        key := read_varint(data, end, &p);
        field := key >> 3;
        wire  := key & 7;

        if field == 1 { // price: double
            if wire != 1 { skip_field(wire, data, end, &p); continue; }
            pr = read_f64_le(data, end, &p);
        } else if field == 2 { // volume: double
            if wire != 1 { skip_field(wire, data, end, &p); continue; }
            vol = read_f64_le(data, end, &p);
        } else if field == 3 { // isBid: bool (varint)
            if wire != 0 { skip_field(wire, data, end, &p); continue; }
            v := read_varint(data, end, &p);
            if (v & 1) != 0 { is_bid = 1.0; } else { is_bid = -1.0; }
        } else {
            skip_field(wire, data, end, &p);
        }
    }

    price^  = pr;
    volume^ = vol;
    signed^ = f32(vol) * is_bid; // signed volume: +bid, -ask
}

// Simple downsampling by bucket-averaging (placeholder for full LTTB).
@(private)
downsample_average :: proc "contextless" (count: i32) -> i32 {
    if count <= 0 {
        heatmap_vertex_count = 0;
        return 0;
    }

    n_in  := clamp_i32(count, 1, MAX_LEVELS);
    // Wenn viele Punkte vorliegen, drosseln wir auf ~500 Buckets,
    // um die GPU zu entlasten. Darunter wird 1:1 durchgereicht.
    MAX_VISIBLE :: 500;
    n_out := n_in;
    if n_out > MAX_VISIBLE {
        n_out = MAX_VISIBLE;
    }

    bucket_size := f64(n_in) / f64(n_out);

    for out_i := 0; out_i < n_out; out_i += 1 {
        start_f := f64(out_i) * bucket_size;
        end_f   := f64(out_i + 1) * bucket_size;
        start   := clamp_i32(i32(start_f), 0, n_in);
        fin     := clamp_i32(i32(end_f),   0, n_in);
        if fin <= start {
            fin = start + 1;
            if fin > n_in { fin = n_in; }
        }

        sum_p: f64 = 0.0;
        sum_s: f64 = 0.0;
        cnt:   f64 = 0.0;

        for j := start; j < fin; j += 1 {
            sum_p += in_prices[j];
            sum_s += f64(in_signed[j]);
            cnt   += 1.0;
        }

        if cnt <= 0.0 {
            continue;
        }

        avg_p := sum_p / cnt;
        avg_s := sum_s / cnt;

        idx := out_i * VERT_STRIDE;
        // xNorm in [0,1]
        if n_out > 1 {
            heatmap_vertices[idx + 0] = f32(f64(out_i) / f64(n_out - 1));
        } else {
            heatmap_vertices[idx + 0] = 0.5;
        }
        heatmap_vertices[idx + 1] = f32(avg_p);
        heatmap_vertices[idx + 2] = f32(avg_s);
    }

    heatmap_vertex_count = n_out;
    return n_out;
}

// ── Exports for JS / TS ────────────────────────────────────────

@export
get_input_offset :: proc "contextless" () -> i32 {
    return i32(uintptr(&heatmap_input[0]));
}

@export
get_input_capacity :: proc "contextless" () -> i32 {
    return INPUT_CAP_BYTES;
}

@export
get_heatmap_vertices_offset :: proc "contextless" () -> i32 {
    return i32(uintptr(&heatmap_vertices[0]));
}

@export
get_heatmap_vertex_count :: proc "contextless" () -> i32 {
    return heatmap_vertex_count;
}

@export
get_heatmap_stride :: proc "contextless" () -> i32 {
    return VERT_STRIDE;
}

// Main entry: parse Protobuf payload at [ptr, ptr+length) and fill vertex buffer.
@export
process_heatmap_payload :: proc "contextless" (ptr: rawptr, length: i32) -> i32 {
    heatmap_vertex_count = 0;
    if length <= 0 { return 0; }

    data := cast([^]u8) ptr;
    if data == nil { return 0; }

    len := length;
    if len > INPUT_CAP_BYTES {
        len = INPUT_CAP_BYTES;
    }

    idx: i32 = 0;
    _frame_ts: i64 = 0; // currently unused, but parsed for completeness
    level_count: i32 = 0;

    // Parse HeatmapFrame
    for idx < len {
        key := read_varint(data, len, &idx);
        if idx >= len && key == 0 {
            break;
        }
        field := key >> 3;
        wire  := key & 7;

        if field == 1 { // ts: int64 (varint)
            if wire != 0 {
                skip_field(wire, data, len, &idx);
                continue;
            }
            ts_u := read_varint(data, len, &idx);
            _frame_ts = i64(ts_u);
        } else if field == 2 { // levels: repeated HeatmapLevel (length-delimited)
            if wire != 2 {
                skip_field(wire, data, len, &idx);
                continue;
            }
            l := read_varint(data, len, &idx);
            msg_len := i32(l);
            if msg_len <= 0 {
                continue;
            }
            start := idx;
            end   := idx + msg_len;
            if end > len {
                end = len;
            }
            if level_count < MAX_LEVELS {
                parse_level(
                    data,
                    start,
                    end,
                    &in_prices[level_count],
                    &in_volumes[level_count],
                    &in_signed[level_count],
                );
                level_count += 1;
            }
            idx = end;
        } else {
            skip_field(wire, data, len, &idx);
        }
    }

    if level_count <= 0 {
        heatmap_vertex_count = 0;
        return 0;
    }

    return downsample_average(level_count);
}

