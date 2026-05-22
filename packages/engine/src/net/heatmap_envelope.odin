// MMT.gg heatmap-column CBOR envelope decoder.
//
// Live `stream:16` frames carry one OB column per frame, encoded as nested
// CBOR maps. Layout (matches `docs/MMT_PROTOCOL.md` §4):
//
//   outer Array → inner ByteString → Map { "0", "1", "2", "3", "4" }
//                                       └── "3" → Map { "0".."9" } = the column
//
// Inside the column map:
//   "0" int  : open_timestamp_seconds
//   "1" map  : { "0": exchange, "1": symbol }
//   "2" floats[] : ask prices
//   "3" floats[] : ask sizes
//   "4" floats[] : bid prices
//   "5" floats[] : bid sizes
//   "6" float    : last_price
//   "7" bool     : snapshot_flag
//   "8" int      : sequence_index
//   "9" int      : channel_id
//
// We never build a Vec/Map AST: the decoder walks the stream, dispatches on
// key, and writes directly into the FlatHeatmap slabs. Zero alloc.
package net

import "../data"

HeatmapEnvelopeDecodeResult :: struct {
    openTimestampSeconds:   i64,
    askLevelCount:          i32,
    bidLevelCount:          i32,
    lastPrice:              f32,
    isSnapshot:             bool,
    sequenceIndex:          i64,
}

// Unwrap a full MMT `stream:16` binary frame to the inner column map reader.
// Wire: Array → ByteString(envelope Map) → field `3` ByteString(column Map).
mmt_cbor_open_heatmap_column :: proc "contextless" (
    frame_reader: ^CborReader,
    column_reader: ^CborReader,
) -> bool {
    outer_count, outer_ok := cbor_read_collection_header(frame_reader, .Array)
    if !outer_ok || outer_count == 0 { return false }

    first_item_start_offset := frame_reader.offset
    first_major_type, first_argument, first_head_ok := cbor_read_head(frame_reader)
    if !first_head_ok { return false }

    envelope_reader: CborReader
    cbor_reader_init(&envelope_reader, frame_reader.bytes, frame_reader.length)
    envelope_reader.offset = first_item_start_offset

    #partial switch first_major_type {
    case .ByteString:
        payload_start_offset := frame_reader.offset
        if first_argument > u64(frame_reader.length) - u64(payload_start_offset) { return false }
        envelope_reader.offset = payload_start_offset
        frame_reader.offset = payload_start_offset + u32(first_argument)
    case .Map:
        // envelope_reader.offset already points at the map head byte.
    case:
        return false
    }

    envelope_entry_count, envelope_ok := cbor_read_collection_header(&envelope_reader, .Map)
    if !envelope_ok { return false }

    for _ in 0..<envelope_entry_count {
        key_value, key_ok := cbor_read_map_key_u8(&envelope_reader)
        if !key_ok { return false }
        if key_value == 3 {
            column_bytes, column_length, column_ok := cbor_read_byte_string_view(&envelope_reader)
            if !column_ok { return false }
            cbor_reader_init(column_reader, column_bytes, column_length)
            for _ in 1..<outer_count {
                if !cbor_skip_item(frame_reader) { return false }
            }
            return true
        }
        if !cbor_skip_item(&envelope_reader) { return false }
    }
    return false
}

// Walks the CBOR-encoded envelope and writes ask/bid price+size pairs into
// the provided FlatHeatmap column. Returns false on malformed input or
// buffer overflow.
//
// The caller has already extracted the inner ByteString and points
// `reader` at the start of the column map (Major Type 5 head).
mmt_decode_heatmap_column_into :: proc "contextless" (
    reader:                ^CborReader,
    heatmap:               ^data.FlatHeatmap,
    column_logical_index:  i32,
    result:                ^HeatmapEnvelopeDecodeResult,
) -> bool {
    map_entry_count, header_ok := cbor_read_collection_header(reader, .Map)
    if !header_ok { return false }

    // Reset any previous data in this column before we re-fill.
    data.flat_heatmap_clear_column(heatmap, column_logical_index)

    // Two-pass: we need ask-prices + ask-sizes paired (same index). The wire
    // format stores them as two consecutive float arrays. We stash a
    // pointer to the price array's start offset and re-decode it together
    // with the size array.
    ask_prices_offset_in_buffer: u32 = 0
    ask_prices_count:            u32 = 0
    bid_prices_offset_in_buffer: u32 = 0
    bid_prices_count:            u32 = 0

    result.askLevelCount = 0
    result.bidLevelCount = 0

    for _ in 0..<map_entry_count {
        key_value, key_ok := cbor_read_map_key_u8(reader)
        if !key_ok { return false }
        switch key_value {
        case 0:  // open_timestamp_seconds
            ts, ts_ok := cbor_read_int64(reader)
            if !ts_ok { return false }
            result.openTimestampSeconds = ts
        case 1:  // pair map — skip; the upstream subscribe already pinned the pair.
            if !cbor_skip_item(reader) { return false }
        case 2:  // ask prices
            ask_prices_offset_in_buffer = reader.offset
            count, ok := scan_float_array_length(reader)
            if !ok { return false }
            ask_prices_count = count
        case 3:  // ask sizes (paired with #2)
            if !write_paired_levels(reader, ask_prices_offset_in_buffer, ask_prices_count,
                                    heatmap, column_logical_index) { return false }
            result.askLevelCount = i32(ask_prices_count)
        case 4:  // bid prices
            bid_prices_offset_in_buffer = reader.offset
            count, ok := scan_float_array_length(reader)
            if !ok { return false }
            bid_prices_count = count
        case 5:  // bid sizes (paired with #4)
            if !write_paired_levels(reader, bid_prices_offset_in_buffer, bid_prices_count,
                                    heatmap, column_logical_index) { return false }
            result.bidLevelCount = i32(bid_prices_count)
        case 6:  // last price (f32 / f64)
            last_price, lp_ok := cbor_read_numeric_f32(reader)
            if !lp_ok { return false }
            result.lastPrice = last_price
        case 7:  // snapshot flag (bool — encoded as SimpleOrFloat 20/21)
            major_type, argument_value, head_ok := cbor_read_head(reader)
            if !head_ok || major_type != .SimpleOrFloat { return false }
            result.isSnapshot = argument_value == 21
        case 8:  // sequence index
            seq, seq_ok := cbor_read_int64(reader)
            if !seq_ok { return false }
            result.sequenceIndex = seq
        case 9:  // channel id — skip; encoded redundantly with stream.
            if !cbor_skip_item(reader) { return false }
        case:    // unknown key
            if !cbor_skip_item(reader) { return false }
        }
    }
    data.flat_heatmap_advance_column(heatmap, result.openTimestampSeconds * 1000)
    return true
}

// Scan past a Major Type 4 (Array) of numeric values and return the element count.
// Leaves the reader cursor just past the array — the caller uses
// `write_paired_levels` to walk back and pair prices with sizes.
scan_float_array_length :: proc "contextless" (reader: ^CborReader) -> (count: u32, ok: bool) {
    array_count, header_ok := cbor_read_collection_header(reader, .Array)
    if !header_ok { return 0, false }
    // Each entry is one CBOR f32 head + 4 bytes payload = 5 B total.
    for _ in 0..<array_count {
        _, fok := cbor_read_numeric_f32(reader)
        if !fok { return 0, false }
    }
    return u32(array_count), true
}

// Walk both the price and the size array (both already-known length =
// `paired_count`) and write each (price, size) into the FlatHeatmap column.
// The price array starts at `prices_offset_in_buffer`; the size array
// starts at the current reader cursor.
@(private)
write_paired_levels :: proc "contextless" (
    reader:                  ^CborReader,
    prices_offset_in_buffer: u32,
    paired_count:            u32,
    heatmap:                 ^data.FlatHeatmap,
    column_logical_index:    i32,
) -> bool {
    if paired_count == 0 { return true }
    size_array_count, header_ok := cbor_read_collection_header(reader, .Array)
    if !header_ok { return false }
    if u32(size_array_count) != paired_count { return false }

    price_reader: CborReader
    cbor_reader_init(&price_reader, reader.bytes, reader.length)
    price_reader.offset = prices_offset_in_buffer
    // Skip the array header on the price side too.
    _, price_header_ok := cbor_read_collection_header(&price_reader, .Array)
    if !price_header_ok { return false }

    for _ in 0..<paired_count {
        price, price_ok := cbor_read_numeric_f32(&price_reader)
        size,  size_ok  := cbor_read_numeric_f32(reader)
        if !price_ok || !size_ok { return false }
        data.flat_heatmap_write_level(heatmap, column_logical_index, f64(price), size)
    }
    return true
}
