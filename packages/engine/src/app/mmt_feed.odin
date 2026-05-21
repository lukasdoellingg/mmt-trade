// Live heatmap ingest from the shell (backend /ws/heatmap protobuf → WASM heap).
package app

import "../data"

HEATMAP_VOLUME_STORAGE_CELLS :: data.HEATMAP_COLUMN_CAPACITY * data.HEATMAP_LEVELS_PER_COLUMN
MAX_LEVELS_PER_WS_FRAME :: 800

@(private="file")
live_flat_heatmap: data.FlatHeatmap

@(private="file")
live_volume_storage: [HEATMAP_VOLUME_STORAGE_CELLS]f32

@(private="file")
live_timestamp_storage: [data.HEATMAP_COLUMN_CAPACITY]i64

@(private="file")
heatmap_bucket_calibrated: bool

@(private="file")
last_heatmap_mid_price: f64

mmt_feed_state :: proc "contextless" () -> ^data.FlatHeatmap {
    return &live_flat_heatmap
}

mmt_feed_reset :: proc "contextless" () {
    heatmap_bucket_calibrated = false
    last_heatmap_mid_price = 0
    data.flat_heatmap_init(
        &live_flat_heatmap,
        &live_volume_storage[0],
        &live_timestamp_storage[0],
        0,
        1,
    )
}

@(private)
calibrate_price_bucket :: proc "contextless" (
    heatmap: ^data.FlatHeatmap,
    min_price, max_price: f64,
) {
    if heatmap_bucket_calibrated { return }
    mid := (min_price + max_price) * 0.5
    if mid <= 0 {
        mid = 50_000
    }
    span := max_price - min_price
    if span < mid * 1e-6 {
        span = mid * 0.02
    }
    step := span / f64(data.HEATMAP_LEVELS_PER_COLUMN)
    if step <= 0 {
        step = mid * 1e-6
    }
    heatmap.bucketPriceMin = mid - f64(data.HEATMAP_LEVELS_PER_COLUMN) * 0.5 * step
    heatmap.bucketPriceStep = step
    heatmap_bucket_calibrated = true
    last_heatmap_mid_price = mid
}

// Called from JS after decoding a HeatmapFrame protobuf blob.
@(export)
mmt_feed_heatmap_frame :: proc "c" (
    bucket_timestamp_ms: i64,
    prices_ptr: rawptr,
    volumes_ptr: rawptr,
    is_bid_flags_ptr: rawptr,
    level_count: i32,
) -> i32 {
    if level_count <= 0 || level_count > MAX_LEVELS_PER_WS_FRAME {
        return -1
    }
    if prices_ptr == nil || volumes_ptr == nil || is_bid_flags_ptr == nil {
        return -2
    }

    prices := cast([^]f64)prices_ptr
    volumes := cast([^]f64)volumes_ptr
    is_bid_flags := cast([^]u8)is_bid_flags_ptr

    min_price := prices[0]
    max_price := prices[0]
    for level_index: i32 = 0; level_index < level_count; level_index += 1 {
        price := prices[level_index]
        if price < min_price { min_price = price }
        if price > max_price { max_price = price }
    }
    calibrate_price_bucket(&live_flat_heatmap, min_price, max_price)

    if live_flat_heatmap.columnCount >= data.HEATMAP_COLUMN_CAPACITY {
        live_flat_heatmap.isRingMode = true
    }

    column_index: i32
    if live_flat_heatmap.isRingMode {
        column_index = live_flat_heatmap.nextWriteColumnIndex
    } else {
        column_index = live_flat_heatmap.columnCount
        if column_index < 0 || column_index >= data.HEATMAP_COLUMN_CAPACITY {
            return -3
        }
    }
    data.flat_heatmap_clear_column(&live_flat_heatmap, column_index)

    for level_index: i32 = 0; level_index < level_count; level_index += 1 {
        data.flat_heatmap_write_level(
            &live_flat_heatmap,
            column_index,
            prices[level_index],
            f32(volumes[level_index]),
        )
        _ = is_bid_flags[level_index]
    }

    data.flat_heatmap_advance_column(&live_flat_heatmap, bucket_timestamp_ms)
    last_heatmap_mid_price = (min_price + max_price) * 0.5
    return live_flat_heatmap.columnCount
}

@(export)
mmt_feed_column_count :: proc "c" () -> i32 {
    return live_flat_heatmap.columnCount
}
