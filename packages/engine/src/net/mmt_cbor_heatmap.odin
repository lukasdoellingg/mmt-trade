// MMT CBOR heatmap column → FlatHeatmap (raw stream path; MUX usually sends protobuf).
package net

import "../data"

MMT_CBOR_MAX_LEVELS :: 2000

@(private="file")
mmt_cbor_level_scratch: [MMT_CBOR_MAX_LEVELS]BackendHeatmapLevel

@(private)
cbor_peek_major_type :: proc "contextless" (reader: ^CborReader) -> (CborMajorType, bool) {
    if reader.offset >= reader.length { return .UnsignedInteger, false }
    return CborMajorType(reader.bytes[reader.offset] >> 5), true
}

@(private)
cbor_read_map_key_int :: proc "contextless" (reader: ^CborReader) -> (key: i64, ok: bool) {
    major_type, argument_value, head_ok := cbor_read_head(reader)
    if !head_ok { return 0, false }
    #partial switch major_type {
    case .UnsignedInteger:
        return i64(argument_value), true
    case .NegativeInteger:
        return -i64(argument_value) - 1, true
    case .TextString:
        if argument_value == 0xFFFF_FFFF_FFFF_FFFF {
            for {
                item_major, item_arg, item_ok := cbor_read_head(reader)
                if !item_ok { return 0, false }
                if item_major == .SimpleOrFloat && item_arg == 31 { break }
                reader.offset -= 1
                if !cbor_skip_item(reader) { return 0, false }
            }
            return 0, false
        }
        if argument_value != 1 {
            if reader.offset + u32(argument_value) > reader.length { return 0, false }
            reader.offset += u32(argument_value)
            return 0, false
        }
        digit, digit_ok := read_byte(reader)
        if !digit_ok || digit < u8('0') || digit > u8('9') { return 0, false }
        return i64(digit - u8('0')), true
    case:
        if !cbor_skip_item(reader) { return 0, false }
        return 0, false
    }
}

@(private)
cbor_decode_root :: proc "contextless" (
    reader: ^CborReader,
) -> (col_reader: CborReader, ok: bool) {
    major_type, major_ok := cbor_peek_major_type(reader)
    if !major_ok { return {}, false }

    if major_type == .Array {
        _, _, head_ok := cbor_read_head(reader)
        if !head_ok { return {}, false }
        return cbor_decode_root(reader)
    }

    if major_type == .ByteString {
        inner_data, inner_len, inner_ok := cbor_read_byte_string(reader)
        if !inner_ok { return {}, false }
        inner: CborReader
        cbor_reader_init(&inner, inner_data, inner_len)
        return cbor_decode_root(&inner)
    }

    if major_type != .Map { return {}, false }

    _, map_len, map_ok := cbor_read_head(reader)
    if !map_ok { return {}, false }

    for _ in 0..<map_len {
        key_int, key_ok := cbor_read_map_key_int(reader)
        if !key_ok {
            if !cbor_skip_item(reader) { return {}, false }
            continue
        }

        if key_int == 3 {
            col_data, col_len, col_ok := cbor_read_byte_string(reader)
            if !col_ok { return {}, false }
            cbor_reader_init(&col_reader, col_data, col_len)
            return col_reader, true
        }
        if !cbor_skip_item(reader) { return {}, false }
    }
    return {}, false
}

@(private)
cbor_read_float_array :: proc "contextless" (
    reader: ^CborReader,
    out: []f64,
) -> (count: i32, ok: bool) {
    major_type, argument_value, head_ok := cbor_read_head(reader)
    if !head_ok || major_type != .Array { return 0, false }
    for index: u64 = 0; index < argument_value; index += 1 {
        if index >= u64(len(out)) { break }
        value, value_ok := cbor_read_number(reader)
        if !value_ok { return count, false }
        out[index] = value
        count += 1
    }
    return count, true
}

@(private)
cbor_map_is_object_column :: proc "contextless" (reader: ^CborReader) -> bool {
    saved := reader.offset
    major_type, argument_value, head_ok := cbor_read_head(reader)
    if !head_ok { return false }
    if major_type != .Map { reader.offset = saved; return false }
    for _ in 0..<argument_value {
        if !cbor_skip_item(reader) { reader.offset = saved; return false }
        if !cbor_skip_item(reader) { reader.offset = saved; return false }
    }
    reader.offset = saved
    return true
}

@(private)
mmt_cbor_column_to_levels :: proc "contextless" (
    col_reader: ^CborReader,
) -> (timestamp_ms: i64, level_count: i32, ok: bool) {
    major_type, map_len, map_ok := cbor_read_head(col_reader)
    if !map_ok || major_type != .Map { return 0, 0, false }

    ts_sec: i64 = 0
    ask_prices: [512]f64
    ask_sizes: [512]f64
    bid_prices: [512]f64
    bid_sizes: [512]f64
    ask_n: i32 = 0
    ask_s_n: i32 = 0
    bid_n: i32 = 0
    bid_s_n: i32 = 0

    for _ in 0..<map_len {
        field_key, key_ok := cbor_read_map_key_int(col_reader)
        if !key_ok { return 0, 0, false }

        switch field_key {
        case 0:
            if cbor_map_is_object_column(col_reader) { return 0, 0, false }
            ts_value, ts_ok := cbor_read_number(col_reader)
            if !ts_ok { return 0, 0, false }
            ts_sec = i64(ts_value)
        case 2:
            ask_n, _ = cbor_read_float_array(col_reader, ask_prices[:])
        case 3:
            ask_s_n, _ = cbor_read_float_array(col_reader, ask_sizes[:])
        case 4:
            bid_n, _ = cbor_read_float_array(col_reader, bid_prices[:])
        case 5:
            bid_s_n, _ = cbor_read_float_array(col_reader, bid_sizes[:])
        case:
            if !cbor_skip_item(col_reader) { return 0, 0, false }
        }
    }

    if ts_sec <= 0 { return 0, 0, false }
    timestamp_ms = ts_sec
    if timestamp_ms < 1_000_000_000_000 {
        timestamp_ms *= 1000
    }

    level_count = 0
    ask_pairs := min(ask_n, ask_s_n)
    for index in 0..<ask_pairs {
        volume := ask_sizes[index]
        if volume <= 0 { continue }
        if level_count >= MMT_CBOR_MAX_LEVELS { break }
        mmt_cbor_level_scratch[level_count] = BackendHeatmapLevel{
            price = ask_prices[index],
            volume = volume,
            isBid = false,
        }
        level_count += 1
    }
    bid_pairs := min(bid_n, bid_s_n)
    for index in 0..<bid_pairs {
        volume := bid_sizes[index]
        if volume <= 0 { continue }
        if level_count >= MMT_CBOR_MAX_LEVELS { break }
        mmt_cbor_level_scratch[level_count] = BackendHeatmapLevel{
            price = bid_prices[index],
            volume = volume,
            isBid = true,
        }
        level_count += 1
    }

    return timestamp_ms, level_count, level_count > 0
}

// Returns true when payload was a recognized MMT heatmap CBOR column/envelope.
mmt_cbor_apply_heatmap_frame :: proc "contextless" (
    heatmap: ^data.FlatHeatmap,
    payload: [^]u8,
    length: u32,
) -> bool {
    if payload == nil || length < 4 || heatmap == nil { return false }

    reader: CborReader
    cbor_reader_init(&reader, payload, length)

    col_reader, root_ok := cbor_decode_root(&reader)
    if !root_ok { return false }

    timestamp_ms, level_count, col_ok := mmt_cbor_column_to_levels(&col_reader)
    if !col_ok { return false }

    levels := mmt_cbor_level_scratch[:level_count]
    return backend_heatmap_apply_levels(heatmap, timestamp_ms, levels)
}
