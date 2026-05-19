// Volume Profile / Visible Range (VPVR) layer.
//
// For the visible bar window, aggregate volume per price bucket, split into
// buy / sell halves using the same aggressor flag the footprint layer uses.
// Drawn as horizontal histogram on the right side of the chart.
package layers

VPVR_MAX_BUCKETS :: 256

VpvrBucket :: struct {
    bucketCenterPrice: f64,
    buyVolume:         f64,
    sellVolume:        f64,
}

VpvrLayerState :: struct {
    buckets:        [VPVR_MAX_BUCKETS]VpvrBucket,
    bucketCount:    i32,
    minVisiblePrice: f64,
    maxVisiblePrice: f64,
    priceStepUsd:   f64,
}

vpvr_layer_reset_for_range :: proc "contextless" (
    state: ^VpvrLayerState,
    visible_min_price, visible_max_price: f64,
    desired_bucket_count: i32,
) {
    bucket_count := desired_bucket_count
    if bucket_count > VPVR_MAX_BUCKETS { bucket_count = VPVR_MAX_BUCKETS }
    if bucket_count < 1 { bucket_count = 1 }
    state.bucketCount = bucket_count
    state.minVisiblePrice = visible_min_price
    state.maxVisiblePrice = visible_max_price
    state.priceStepUsd = (visible_max_price - visible_min_price) / f64(bucket_count)
    for bucket_index: i32 = 0; bucket_index < bucket_count; bucket_index += 1 {
        state.buckets[bucket_index] = VpvrBucket{
            bucketCenterPrice = visible_min_price + (f64(bucket_index) + 0.5) * state.priceStepUsd,
            buyVolume = 0,
            sellVolume = 0,
        }
    }
}

vpvr_layer_record_trade :: #force_inline proc "contextless" (
    state: ^VpvrLayerState,
    trade_price: f64,
    trade_volume: f64,
    is_buyer_aggressor: bool,
) {
    if state.priceStepUsd <= 0 { return }
    if trade_price < state.minVisiblePrice || trade_price > state.maxVisiblePrice { return }
    bucket_index := i32((trade_price - state.minVisiblePrice) / state.priceStepUsd)
    if bucket_index < 0 || bucket_index >= state.bucketCount { return }
    if is_buyer_aggressor {
        state.buckets[bucket_index].buyVolume += trade_volume
    } else {
        state.buckets[bucket_index].sellVolume += trade_volume
    }
}

// Returns the bucket index that holds the visible range's Point of Control.
vpvr_layer_point_of_control_index :: proc "contextless" (state: ^VpvrLayerState) -> i32 {
    if state.bucketCount == 0 { return -1 }
    best_index: i32 = 0
    best_total: f64 = -1
    for bucket_index: i32 = 0; bucket_index < state.bucketCount; bucket_index += 1 {
        total := state.buckets[bucket_index].buyVolume + state.buckets[bucket_index].sellVolume
        if total > best_total { best_total = total; best_index = bucket_index }
    }
    return best_index
}
