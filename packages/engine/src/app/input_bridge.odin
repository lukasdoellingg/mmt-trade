// JS → WASM input bridge over a SharedArrayBuffer ring.
//
// Layout (32-byte slots, fits two cache lines):
//   offset 0  u32  eventTypeTag       (see InputEventType)
//   offset 4  i32  flagsAndButtons
//   offset 8  f32  positionX_cssPx
//   offset 12 f32  positionY_cssPx
//   offset 16 f32  deltaX_cssPx       (wheel events: pixel-equivalent)
//   offset 20 f32  deltaY_cssPx
//   offset 24 i32  reserved_keyCode
//   offset 28 i32  reserved
//
// The JS shell writes events into the ring via `Atomics.store` and bumps
// `writeIndex` (last 8 bytes of the header). The engine polls in `app_step`
// and drains everything up to `writeIndex`. Single-producer/single-consumer
// → no locks, just memory ordering.
//
// Capacity (slot count) is a power of two so wrapping can use a mask.
package app

INPUT_RING_SLOT_COUNT  :: 256          // 256 * 32 B = 8 KiB
INPUT_RING_SLOT_BYTES  :: 32

InputEventType :: enum u32 {
    MouseMove      = 1,
    MouseDown      = 2,
    MouseUp        = 3,
    MouseLeave     = 4,
    Wheel          = 5,
    KeyDown        = 6,
    KeyUp          = 7,
    Resize         = 8,
    Focus          = 9,
    Blur           = 10,
}

InputEvent :: struct {
    eventType:           InputEventType,
    flagsAndButtons:     i32,
    positionXCssPx:      f32,
    positionYCssPx:      f32,
    deltaXCssPx:         f32,
    deltaYCssPx:         f32,
    reservedKeyCode:     i32,
    reservedSecondary:   i32,
}

InputRingHeader :: struct {
    writeIndex:    u32,   // written by JS shell only
    readIndex:    u32,   // written by WASM only
    capacity:      u32,
    mask:          u32,
}

// Pointers populated by the bridge boot. The shell allocates the
// SharedArrayBuffer-backed memory and exports its base pointer via
// `input_bridge_bind_storage`.
@(private="file") ringHeader: ^InputRingHeader = nil
@(private="file") ringSlots:  [^]InputEvent    = nil

@(export)
input_bridge_bind_storage :: proc "c" (
    header_ptr: ^InputRingHeader, slots_ptr: [^]InputEvent, capacity_slots: u32,
) {
    ringHeader = header_ptr
    ringSlots  = slots_ptr
    if header_ptr != nil {
        header_ptr.capacity = capacity_slots
        header_ptr.mask     = capacity_slots - 1
        header_ptr.readIndex = 0
        header_ptr.writeIndex = 0
    }
}

// Called from `app.poll_input_events` once per RAF. Drains every event the
// JS shell has posted since the last call; returns the number of events
// consumed (useful for back-pressure metrics).
poll_input_ring :: proc "contextless" (
    on_event: proc "contextless" (event: ^InputEvent),
) -> u32 {
    if ringHeader == nil || ringSlots == nil { return 0 }
    consumed: u32 = 0
    write := ringHeader.writeIndex
    read  := ringHeader.readIndex
    for read != write {
        slot := &ringSlots[read & ringHeader.mask]
        on_event(slot)
        read += 1
        consumed += 1
    }
    ringHeader.readIndex = read
    return consumed
}

input_ring_pending_count :: #force_inline proc "contextless" () -> u32 {
    if ringHeader == nil { return 0 }
    return ringHeader.writeIndex - ringHeader.readIndex
}
