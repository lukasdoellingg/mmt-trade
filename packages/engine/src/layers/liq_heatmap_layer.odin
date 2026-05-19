// Liquidation cluster heatmap.
//
// Aggregates recent liquidation events into a 2D grid (price × time) and
// renders them like the OB heatmap but with a distinct colormap. Useful for
// spotting "magnet" liquidation zones.
package layers

LIQ_HEATMAP_TIME_BUCKETS  :: 128
LIQ_HEATMAP_PRICE_BUCKETS :: 256

LiqHeatmapGrid :: struct {
    volumeUsdPerCell:        [LIQ_HEATMAP_TIME_BUCKETS][LIQ_HEATMAP_PRICE_BUCKETS]f32,
    firstTimestampMs:        i64,
    millisecondsPerTimeBucket: i64,
    minPriceUsd:             f64,
    priceStepUsdPerBucket:   f64,
}

liq_heatmap_grid_reset :: proc "contextless" (
    grid:                          ^LiqHeatmapGrid,
    first_timestamp_ms:            i64,
    milliseconds_per_time_bucket:  i64,
    min_price_usd:                 f64,
    price_step_usd_per_bucket:     f64,
) {
    grid.firstTimestampMs = first_timestamp_ms
    grid.millisecondsPerTimeBucket = milliseconds_per_time_bucket
    grid.minPriceUsd = min_price_usd
    grid.priceStepUsdPerBucket = price_step_usd_per_bucket
    for time_bucket in 0..<LIQ_HEATMAP_TIME_BUCKETS {
        for price_bucket in 0..<LIQ_HEATMAP_PRICE_BUCKETS {
            grid.volumeUsdPerCell[time_bucket][price_bucket] = 0
        }
    }
}

liq_heatmap_grid_add_event :: #force_inline proc "contextless" (
    grid:        ^LiqHeatmapGrid,
    timestamp_ms: i64,
    price_usd:    f64,
    quote_value_usd: f32,
) {
    if grid.millisecondsPerTimeBucket <= 0 { return }
    time_bucket := i32((timestamp_ms - grid.firstTimestampMs) / grid.millisecondsPerTimeBucket)
    if time_bucket < 0 || time_bucket >= LIQ_HEATMAP_TIME_BUCKETS { return }
    price_bucket := i32((price_usd - grid.minPriceUsd) / grid.priceStepUsdPerBucket)
    if price_bucket < 0 || price_bucket >= LIQ_HEATMAP_PRICE_BUCKETS { return }
    grid.volumeUsdPerCell[time_bucket][price_bucket] += quote_value_usd
}
