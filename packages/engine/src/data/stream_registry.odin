// Shared stream subscriptions — refcount per FeedHub stream key (zero alloc hot path).
package data

MAX_REGISTERED_STREAMS :: 32
MAX_EXCHANGE_BYTES :: 96
MAX_SYMBOL_BYTES :: 24

StreamKind :: enum u8 {
    Unknown = 0,
    HeatmapAggregated = 1,
    Candles = 2,
    LiveTick = 3,
}

StreamKeyParts :: struct {
    exchange:           string,
    symbol:             string,
    streamId:           i32,
    timeframeSeconds:   i32,
    bucketGroup:        i32,
    kind:               StreamKind,
}

StreamSlot :: struct {
    exchangeBytes:      [MAX_EXCHANGE_BYTES]u8,
    exchangeLength:     i32,
    symbolBytes:        [MAX_SYMBOL_BYTES]u8,
    symbolLength:       i32,
    streamId:           i32,
    timeframeSeconds:   i32,
    bucketGroup:        i32,
    refcount:           i32,
    isSubscribed:       bool,
    kind:               StreamKind,
}

StreamRegistry :: struct {
    slots:              [MAX_REGISTERED_STREAMS]StreamSlot,
    activeSlotCount:    i32,
}

stream_registry_init :: proc "contextless" (registry: ^StreamRegistry) {
    for index in 0..<MAX_REGISTERED_STREAMS {
        registry.slots[index].exchangeLength = 0
        registry.slots[index].symbolLength = 0
        registry.slots[index].refcount = 0
        registry.slots[index].isSubscribed = false
    }
    registry.activeSlotCount = 0
}

@(private)
copy_exchange :: proc "contextless" (dest: ^StreamSlot, src: string) {
    count := min(len(src), MAX_EXCHANGE_BYTES)
    for index in 0..<count {
        dest.exchangeBytes[index] = src[index]
    }
    dest.exchangeLength = i32(count)
}

@(private)
copy_symbol :: proc "contextless" (dest: ^StreamSlot, src: string) {
    count := min(len(src), MAX_SYMBOL_BYTES)
    for index in 0..<count {
        dest.symbolBytes[index] = src[index]
    }
    dest.symbolLength = i32(count)
}

@(private)
slots_match :: proc "contextless" (
    slot: ^StreamSlot,
    exchange: string,
    symbol: string,
    stream_id: i32,
    timeframe_seconds: i32,
    bucket_group: i32,
) -> bool {
    if slot.exchangeLength == 0 { return false }
    if slot.streamId != stream_id { return false }
    if slot.timeframeSeconds != timeframe_seconds { return false }
    if slot.bucketGroup != bucket_group { return false }
    if slot.symbolLength != i32(len(symbol)) { return false }
    if slot.exchangeLength != i32(len(exchange)) { return false }
    for index in 0..<len(symbol) {
        if slot.symbolBytes[index] != symbol[index] { return false }
    }
    for index in 0..<len(exchange) {
        if slot.exchangeBytes[index] != exchange[index] { return false }
    }
    return true
}

@(private)
alloc_slot :: proc "contextless" (registry: ^StreamRegistry) -> i32 {
    for index in 0..<MAX_REGISTERED_STREAMS {
        if registry.slots[index].exchangeLength == 0 {
            return i32(index)
        }
    }
    return -1
}

stream_registry_acquire :: proc "contextless" (
    registry: ^StreamRegistry,
    parts: StreamKeyParts,
) -> (slot_index: i32, needs_subscribe: bool) {
    for index in 0..<MAX_REGISTERED_STREAMS {
        slot := &registry.slots[index]
        if slots_match(slot, parts.exchange, parts.symbol, parts.streamId, parts.timeframeSeconds, parts.bucketGroup) {
            slot.refcount += 1
            return i32(index), !slot.isSubscribed
        }
    }
    free_index := alloc_slot(registry)
    if free_index < 0 { return -1, false }
    slot := &registry.slots[free_index]
    copy_exchange(slot, parts.exchange)
    copy_symbol(slot, parts.symbol)
    slot.streamId = parts.streamId
    slot.timeframeSeconds = parts.timeframeSeconds
    slot.bucketGroup = parts.bucketGroup
    slot.kind = parts.kind
    slot.refcount = 1
    slot.isSubscribed = false
    registry.activeSlotCount += 1
    return free_index, true
}

stream_registry_release :: proc "contextless" (registry: ^StreamRegistry, slot_index: i32) -> bool {
    if slot_index < 0 || slot_index >= MAX_REGISTERED_STREAMS { return false }
    slot := &registry.slots[slot_index]
    if slot.exchangeLength == 0 { return false }
    slot.refcount -= 1
    if slot.refcount > 0 { return false }
    slot.exchangeLength = 0
    slot.symbolLength = 0
    slot.isSubscribed = false
    registry.activeSlotCount -= 1
    return true
}

stream_registry_mark_subscribed :: proc "contextless" (registry: ^StreamRegistry, slot_index: i32) {
    if slot_index < 0 || slot_index >= MAX_REGISTERED_STREAMS { return }
    registry.slots[slot_index].isSubscribed = true
}

stream_registry_slot_exchange :: proc "contextless" (
    registry: ^StreamRegistry,
    slot_index: i32,
) -> string {
    if slot_index < 0 || slot_index >= MAX_REGISTERED_STREAMS { return "" }
    slot := &registry.slots[slot_index]
    return string(slot.exchangeBytes[:slot.exchangeLength])
}

stream_registry_slot_symbol :: proc "contextless" (
    registry: ^StreamRegistry,
    slot_index: i32,
) -> string {
    if slot_index < 0 || slot_index >= MAX_REGISTERED_STREAMS { return "" }
    slot := &registry.slots[slot_index]
    return string(slot.symbolBytes[:slot.symbolLength])
}
