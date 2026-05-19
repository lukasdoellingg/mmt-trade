// Order book depth polygon (DOM) layer.
//
// Builds a cumulative depth polyline for bids (descending from mid) and asks
// (ascending from mid). Drawn as two filled polygons left of the chart.
package layers

OB_DEPTH_MAX_POINTS_PER_SIDE :: 512

OrderBookDepthPoint :: struct {
    price:                f64,
    cumulativeVolumeBase: f64,
}

OrderBookDepthLayer :: struct {
    bidPoints:        [OB_DEPTH_MAX_POINTS_PER_SIDE]OrderBookDepthPoint,
    askPoints:        [OB_DEPTH_MAX_POINTS_PER_SIDE]OrderBookDepthPoint,
    bidPointCount:    i32,
    askPointCount:    i32,
}

// Pass bid levels sorted by descending price, asks by ascending price.
ob_depth_layer_build :: proc "contextless" (
    layer:            ^OrderBookDepthLayer,
    bid_prices, bid_volumes: [^]f64,
    bid_level_count:  i32,
    ask_prices, ask_volumes: [^]f64,
    ask_level_count:  i32,
) {
    cumulative: f64 = 0
    bid_emit_count := bid_level_count
    if bid_emit_count > OB_DEPTH_MAX_POINTS_PER_SIDE { bid_emit_count = OB_DEPTH_MAX_POINTS_PER_SIDE }
    for index: i32 = 0; index < bid_emit_count; index += 1 {
        cumulative += bid_volumes[index]
        layer.bidPoints[index] = OrderBookDepthPoint{
            price = bid_prices[index],
            cumulativeVolumeBase = cumulative,
        }
    }
    layer.bidPointCount = bid_emit_count

    cumulative = 0
    ask_emit_count := ask_level_count
    if ask_emit_count > OB_DEPTH_MAX_POINTS_PER_SIDE { ask_emit_count = OB_DEPTH_MAX_POINTS_PER_SIDE }
    for index: i32 = 0; index < ask_emit_count; index += 1 {
        cumulative += ask_volumes[index]
        layer.askPoints[index] = OrderBookDepthPoint{
            price = ask_prices[index],
            cumulativeVolumeBase = cumulative,
        }
    }
    layer.askPointCount = ask_emit_count
}
