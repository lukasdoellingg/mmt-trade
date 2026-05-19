// CBOR decoder — subset large enough to parse MMT.gg's heatmap envelope.
//
// We only handle the major types the MMT protocol uses:
//   0  unsigned integer
//   1  negative integer
//   2  byte string
//   3  text string
//   4  array
//   5  map
//   6  tag (skipped — payload still decoded)
//   7  float / bool / null / break
//
// Zero allocation: numeric values are returned by reference into the input
// buffer; map keys are visited via callback. We never build an AST.
package net

CborMajorType :: enum u8 {
    UnsignedInteger = 0,
    NegativeInteger = 1,
    ByteString      = 2,
    TextString      = 3,
    Array           = 4,
    Map             = 5,
    Tag             = 6,
    SimpleOrFloat   = 7,
}

CborReader :: struct {
    bytes:   [^]u8,
    offset:  u32,
    length:  u32,
}

cbor_reader_init :: proc "contextless" (reader: ^CborReader, data: [^]u8, length: u32) {
    reader.bytes = data
    reader.offset = 0
    reader.length = length
}

@(private)
read_byte :: #force_inline proc "contextless" (reader: ^CborReader) -> (u8, bool) {
    if reader.offset >= reader.length { return 0, false }
    value := reader.bytes[reader.offset]
    reader.offset += 1
    return value, true
}

@(private)
read_be_u16 :: #force_inline proc "contextless" (reader: ^CborReader) -> (u16, bool) {
    if reader.offset + 2 > reader.length { return 0, false }
    hi := u16(reader.bytes[reader.offset])
    lo := u16(reader.bytes[reader.offset + 1])
    reader.offset += 2
    return (hi << 8) | lo, true
}

@(private)
read_be_u32 :: #force_inline proc "contextless" (reader: ^CborReader) -> (u32, bool) {
    if reader.offset + 4 > reader.length { return 0, false }
    value := u32(reader.bytes[reader.offset]) << 24
           | u32(reader.bytes[reader.offset + 1]) << 16
           | u32(reader.bytes[reader.offset + 2]) << 8
           | u32(reader.bytes[reader.offset + 3])
    reader.offset += 4
    return value, true
}

@(private)
read_be_u64 :: #force_inline proc "contextless" (reader: ^CborReader) -> (u64, bool) {
    if reader.offset + 8 > reader.length { return 0, false }
    value: u64 = 0
    for byte_index in 0..<8 {
        value = (value << 8) | u64(reader.bytes[reader.offset + u32(byte_index)])
    }
    reader.offset += 8
    return value, true
}

// Decode the leading initial byte into a (major type, argument value).
// Returns false if the buffer is exhausted or the argument is malformed.
cbor_read_head :: proc "contextless" (
    reader: ^CborReader,
) -> (major_type: CborMajorType, argument_value: u64, ok: bool) {
    initial_byte, byte_ok := read_byte(reader)
    if !byte_ok { return CborMajorType.UnsignedInteger, 0, false }
    major_type = CborMajorType(initial_byte >> 5)
    additional := initial_byte & 0x1F
    switch additional {
    case 0..=23:
        return major_type, u64(additional), true
    case 24:
        u8_value, ok2 := read_byte(reader)
        return major_type, u64(u8_value), ok2
    case 25:
        u16_value, ok2 := read_be_u16(reader)
        return major_type, u64(u16_value), ok2
    case 26:
        u32_value, ok2 := read_be_u32(reader)
        return major_type, u64(u32_value), ok2
    case 27:
        u64_value, ok2 := read_be_u64(reader)
        return major_type, u64_value, ok2
    case 31:
        // Indefinite length — caller handles via repeated cbor_read_head calls.
        return major_type, 0xFFFF_FFFF_FFFF_FFFF, true
    }
    return major_type, 0, false
}

cbor_read_float :: proc "contextless" (reader: ^CborReader) -> (value: f64, ok: bool) {
    major_type, argument_value, head_ok := cbor_read_head(reader)
    if !head_ok || major_type != .SimpleOrFloat { return 0, false }
    // additional 25 = half (skipped), 26 = float, 27 = double.
    if argument_value == 0 || argument_value == 21 { return 0, true }   // false/null
    // For our purposes the only floats MMT emits in the heatmap envelope are
    // f32 (additional 26) and f64 (additional 27). We can't distinguish from
    // the argument value alone here — caller must use the typed helpers below.
    return 0, false
}

cbor_read_float32 :: proc "contextless" (reader: ^CborReader) -> (value: f32, ok: bool) {
    raw, raw_ok := read_be_u32(reader)
    if !raw_ok { return 0, false }
    return transmute(f32) raw, true
}

cbor_read_float64 :: proc "contextless" (reader: ^CborReader) -> (value: f64, ok: bool) {
    raw, raw_ok := read_be_u64(reader)
    if !raw_ok { return 0, false }
    return transmute(f64) raw, true
}

// Skip the next item entirely (used to step past tags or unknown map keys).
cbor_skip_item :: proc "contextless" (reader: ^CborReader) -> bool {
    major_type, argument_value, head_ok := cbor_read_head(reader)
    if !head_ok { return false }
    switch major_type {
    case .UnsignedInteger, .NegativeInteger, .SimpleOrFloat:
        return true
    case .ByteString, .TextString:
        if argument_value > u64(reader.length) - u64(reader.offset) { return false }
        reader.offset += u32(argument_value)
        return true
    case .Array:
        for _ in 0..<argument_value {
            if !cbor_skip_item(reader) { return false }
        }
        return true
    case .Map:
        for _ in 0..<argument_value {
            if !cbor_skip_item(reader) { return false } // key
            if !cbor_skip_item(reader) { return false } // value
        }
        return true
    case .Tag:
        return cbor_skip_item(reader)
    }
    return false
}
