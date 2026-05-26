// SAB ring for WS frames → decode worker (fixed size, zero alloc hot path).
package data

FRAME_RING_CAPACITY :: 8
MAX_FRAME_BYTES :: 1 << 18  // 256 KiB — matches workers/decode_worker.odin

FrameRing :: struct {
    rawBytes:             [FRAME_RING_CAPACITY * MAX_FRAME_BYTES]u8,
    frameLengths:         [FRAME_RING_CAPACITY]u32,
    headIndex:            u32,
    tailIndex:            u32,
}

frame_ring_init :: proc "contextless" (ring: ^FrameRing) {
    ring.headIndex = 0
    ring.tailIndex = 0
    for index in 0..<FRAME_RING_CAPACITY {
        ring.frameLengths[index] = 0
    }
}

frame_ring_is_empty :: proc "contextless" (ring: ^FrameRing) -> bool {
    return ring.headIndex == ring.tailIndex
}

// Push copies payload into next slot; returns false if ring full or frame too large.
frame_ring_push :: proc "contextless" (
    ring: ^FrameRing,
    payload: [^]u8,
    length: u32,
) -> bool {
    if length == 0 || length > MAX_FRAME_BYTES { return false }
    next_tail := (ring.tailIndex + 1) % FRAME_RING_CAPACITY
    if next_tail == ring.headIndex { return false }
    slot_index := ring.tailIndex % FRAME_RING_CAPACITY
    offset := slot_index * MAX_FRAME_BYTES
    for index in 0..<int(length) {
        ring.rawBytes[offset + u32(index)] = payload[index]
    }
    ring.frameLengths[slot_index] = length
    ring.tailIndex = next_tail
    return true
}

frame_ring_pop_length :: proc "contextless" (ring: ^FrameRing) -> u32 {
    if frame_ring_is_empty(ring) { return 0 }
    slot_index := ring.headIndex % FRAME_RING_CAPACITY
    return ring.frameLengths[slot_index]
}

frame_ring_pop_slice :: proc "contextless" (ring: ^FrameRing) -> (^u8, u32) {
    if frame_ring_is_empty(ring) { return nil, 0 }
    slot_index := ring.headIndex % FRAME_RING_CAPACITY
    offset := slot_index * MAX_FRAME_BYTES
    length := ring.frameLengths[slot_index]
    ring.frameLengths[slot_index] = 0
    ring.headIndex += 1
    return &ring.rawBytes[offset], length
}
