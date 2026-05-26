// Decode web/backend HeatmapFrame protobuf (proto3) into FlatHeatmap.
package net

import "../data"

BACKEND_HEATMAP_MAX_LEVELS :: 2000

BackendHeatmapLevel :: struct {
    price:  f64,
    volume: f64,
    isBid:  bool,
}

@(private="file")
backend_level_scratch: [BACKEND_HEATMAP_MAX_LEVELS]BackendHeatmapLevel

@(private)
proto_read_varint :: proc "contextless" (
    bytes: [^]u8,
    length: u32,
    offset: ^u32,
) -> (value: u64, ok: bool) {
    result: u64 = 0
    shift: u32 = 0
    for _ in 0..<10 {
        if offset^ >= length { return 0, false }
        byte := bytes[offset^]
        offset^ += 1
        result |= u64(byte & 0x7f) << shift
        if (byte & 0x80) == 0 {
            return result, true
        }
        shift += 7
    }
    return 0, false
}

@(private)
proto_read_double :: proc "contextless" (
    bytes: [^]u8,
    length: u32,
    offset: ^u32,
) -> (value: f64, ok: bool) {
    if offset^ + 8 > length { return 0, false }
    bits: u64 = 0
    for index: u32 = 0; index < 8; index += 1 {
        bits |= u64(bytes[offset^ + index]) << (index * 8)
    }
    offset^ += 8
    return transmute(f64)bits, true
}

@(private)
proto_skip_field :: proc "contextless" (
    bytes: [^]u8,
    length: u32,
    offset: ^u32,
    wire: u32,
) -> bool {
    switch wire {
    case 0:
        _, ok := proto_read_varint(bytes, length, offset)
        return ok
    case 1:
        if offset^ + 8 > length { return false }
        offset^ += 8
        return true
    case 2:
        len, ok := proto_read_varint(bytes, length, offset)
        if !ok { return false }
        if offset^ + u32(len) > length { return false }
        offset^ += u32(len)
        return true
    case 5:
        if offset^ + 4 > length { return false }
        offset^ += 4
        return true
    case:
        return false
    }
}

@(private)
proto_decode_level :: proc "contextless" (
    bytes: [^]u8,
    length: u32,
    offset: ^u32,
    end: u32,
) -> (level: BackendHeatmapLevel, ok: bool) {
    level = {}
    for offset^ < end && offset^ < length {
        tag, tag_ok := proto_read_varint(bytes, length, offset)
        if !tag_ok { return level, false }
        field := tag >> 3
        wire := u32(tag & 7)
        switch field {
        case 1:
            if wire != 1 { return level, false }
            value, value_ok := proto_read_double(bytes, length, offset)
            if !value_ok { return level, false }
            level.price = value
        case 2:
            if wire != 1 { return level, false }
            value, value_ok := proto_read_double(bytes, length, offset)
            if !value_ok { return level, false }
            level.volume = value
        case 3:
            if wire != 0 { return level, false }
            value, value_ok := proto_read_varint(bytes, length, offset)
            if !value_ok { return level, false }
            level.isBid = value != 0
        case:
            if !proto_skip_field(bytes, length, offset, wire) {
                return level, false
            }
        }
    }
    return level, true
}

@(private)
backend_heatmap_refit_buckets :: proc "contextless" (
    heatmap: ^data.FlatHeatmap,
    levels: []BackendHeatmapLevel,
) {
    if len(levels) == 0 { return }
    min_price := levels[0].price
    max_price := levels[0].price
    for level in levels[1:] {
        if level.price < min_price { min_price = level.price }
        if level.price > max_price { max_price = level.price }
    }
    span := max_price - min_price
    if span < 1.0 { span = 1.0 }
    heatmap.bucketPriceMin = min_price - span * 0.05
    heatmap.bucketPriceStep = span / f64(data.HEATMAP_LEVELS_PER_COLUMN - 1)
}

@(private)
backend_heatmap_apply_levels :: proc "contextless" (
    heatmap: ^data.FlatHeatmap,
    timestamp_ms: i64,
    levels: []BackendHeatmapLevel,
) -> bool {
    if len(levels) == 0 { return false }
    if heatmap.columnCount == 0 {
        backend_heatmap_refit_buckets(heatmap, levels)
    }

    logical_column := heatmap.columnCount
    if heatmap.columnCount >= data.HEATMAP_COLUMN_CAPACITY {
        logical_column = data.HEATMAP_COLUMN_CAPACITY - 1
    }
    data.flat_heatmap_clear_column(heatmap, logical_column)
    data.flat_heatmap_advance_column(heatmap, timestamp_ms)

    for level in levels {
        if level.volume <= 0 { continue }
        data.flat_heatmap_write_level(heatmap, logical_column, level.price, f32(level.volume))
    }
    return true
}

backend_proto_apply_heatmap_frame :: proc "contextless" (
    heatmap: ^data.FlatHeatmap,
    payload: [^]u8,
    length: u32,
) -> bool {
    if payload == nil || length == 0 || heatmap.volumeCells == nil { return false }

    offset: u32 = 0
    timestamp_ms: i64 = 0
    level_count: i32 = 0

    for offset < length {
        tag, tag_ok := proto_read_varint(payload, length, &offset)
        if !tag_ok { return false }
        field := tag >> 3
        wire := u32(tag & 7)

        if field == 1 && wire == 0 {
            value, value_ok := proto_read_varint(payload, length, &offset)
            if !value_ok { return false }
            timestamp_ms = i64(value)
            continue
        }
        if field == 2 && wire == 2 {
            len, len_ok := proto_read_varint(payload, length, &offset)
            if !len_ok { return false }
            end := offset + u32(len)
            for offset < end && level_count < BACKEND_HEATMAP_MAX_LEVELS {
                level, level_ok := proto_decode_level(payload, length, &offset, end)
                if !level_ok { break }
                backend_level_scratch[level_count] = level
                level_count += 1
            }
            offset = end
            continue
        }
        if !proto_skip_field(payload, length, &offset, wire) {
            return false
        }
    }

    if timestamp_ms <= 0 { return false }
    if timestamp_ms < 1_000_000_000_000 {
        timestamp_ms *= 1000
    }
    levels := backend_level_scratch[:level_count]
    return backend_heatmap_apply_levels(heatmap, timestamp_ms, levels)
}
