// Phase G — Symbol list data store (mmt.gg stream:9 ticker stats).
//
// Holds up-to-MAX_LISTED_SYMBOLS tradable pairs with a live snapshot of last
// price, 24h delta percent and 24h quote volume. Stream:9 CBOR frames land
// here through `symbol_list_record_ticker` (called from `net/feed.odin`
// once that decoder ships); the `ui` package reads the snapshot each frame
// to render one ImGui row per entry.
//
// The struct lives in `data` instead of `ui` because the engine's `app`
// package also needs to address it (active-symbol bookkeeping) — a UI-side
// store would create an `app → ui` import cycle.
package data

SYMBOL_LIST_NAME_BYTES   :: 16
SYMBOL_LIST_MAX_ENTRIES  :: 256
SYMBOL_LIST_DISPLAY_ROWS :: 24

SymbolListSortKind :: enum u8 {
    Alphabetical          = 0,
    QuoteVolume24hDesc    = 1,
    PriceChangePct24hDesc = 2,
}

SymbolListEntry :: struct {
    symbolNameBytes:        [SYMBOL_LIST_NAME_BYTES]u8,
    symbolNameLength:       u8,
    lastPrice:              f64,
    priceChangePercent24h:  f64,
    quoteVolume24h:         f64,
    timestampMs:            i64,
    isActive:               bool,
}

SymbolListState :: struct {
    entries:        [SYMBOL_LIST_MAX_ENTRIES]SymbolListEntry,
    entryCount:     i32,
    activeSortKind: SymbolListSortKind,
}

symbol_list_init :: proc "contextless" (state: ^SymbolListState) {
    state.entryCount = 0
    state.activeSortKind = .QuoteVolume24hDesc
}

symbol_list_record_ticker :: proc "contextless" (
    state:                   ^SymbolListState,
    symbol_name_bytes:       []u8,
    last_price:              f64,
    price_change_percent_24h: f64,
    quote_volume_24h:        f64,
    timestamp_ms:            i64,
) {
    if state == nil { return }
    name_length := i32(len(symbol_name_bytes))
    if name_length <= 0 { return }
    if name_length > SYMBOL_LIST_NAME_BYTES {
        name_length = SYMBOL_LIST_NAME_BYTES
    }

    target_index: i32 = -1
    for index: i32 = 0; index < state.entryCount; index += 1 {
        if symbol_names_match(&state.entries[index], symbol_name_bytes, name_length) {
            target_index = index
            break
        }
    }
    if target_index < 0 {
        if state.entryCount >= SYMBOL_LIST_MAX_ENTRIES { return }
        target_index = state.entryCount
        state.entryCount += 1
        entry := &state.entries[target_index]
        for byte_index: i32 = 0; byte_index < name_length; byte_index += 1 {
            entry.symbolNameBytes[byte_index] = symbol_name_bytes[byte_index]
        }
        entry.symbolNameLength = u8(name_length)
    }
    entry := &state.entries[target_index]
    entry.lastPrice = last_price
    entry.priceChangePercent24h = price_change_percent_24h
    entry.quoteVolume24h = quote_volume_24h
    entry.timestampMs = timestamp_ms
    entry.isActive = true
}

@(private)
symbol_names_match :: proc "contextless" (
    entry: ^SymbolListEntry, name_bytes: []u8, name_length: i32,
) -> bool {
    if i32(entry.symbolNameLength) != name_length { return false }
    for byte_index: i32 = 0; byte_index < name_length; byte_index += 1 {
        if entry.symbolNameBytes[byte_index] != name_bytes[byte_index] { return false }
    }
    return true
}

symbol_list_sort_rows :: proc "contextless" (state: ^SymbolListState) {
    if state.entryCount <= 1 { return }
    for outer_index: i32 = 1; outer_index < state.entryCount; outer_index += 1 {
        cursor := outer_index
        for cursor > 0 && symbol_list_compare(
            &state.entries[cursor],
            &state.entries[cursor - 1],
            state.activeSortKind,
        ) < 0 {
            state.entries[cursor], state.entries[cursor - 1] = state.entries[cursor - 1], state.entries[cursor]
            cursor -= 1
        }
    }
}

@(private)
symbol_list_compare :: proc "contextless" (
    a, b: ^SymbolListEntry, kind: SymbolListSortKind,
) -> i32 {
    switch kind {
    case .QuoteVolume24hDesc:
        if a.quoteVolume24h > b.quoteVolume24h { return -1 }
        if a.quoteVolume24h < b.quoteVolume24h { return 1 }
        return 0
    case .PriceChangePct24hDesc:
        if a.priceChangePercent24h > b.priceChangePercent24h { return -1 }
        if a.priceChangePercent24h < b.priceChangePercent24h { return 1 }
        return 0
    case .Alphabetical:
        n := i32(a.symbolNameLength)
        if i32(b.symbolNameLength) < n { n = i32(b.symbolNameLength) }
        for index: i32 = 0; index < n; index += 1 {
            if a.symbolNameBytes[index] < b.symbolNameBytes[index] { return -1 }
            if a.symbolNameBytes[index] > b.symbolNameBytes[index] { return 1 }
        }
        if a.symbolNameLength < b.symbolNameLength { return -1 }
        if a.symbolNameLength > b.symbolNameLength { return 1 }
        return 0
    }
    return 0
}
