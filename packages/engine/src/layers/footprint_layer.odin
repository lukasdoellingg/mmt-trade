// Footprint chart layer.
//
// Each candle is split into price-cells. Within each cell we accumulate:
//   - aggressive buy volume (taker buy)
//   - aggressive sell volume (taker sell)
//   - imbalance ratio (buy - sell) / (buy + sell)
//   - whether this cell contains the candle's Point of Control (POC)
//
// Drawn as a textured quad per candle: numbers in cell + colored bar.
package layers

FOOTPRINT_MAX_PRICE_CELLS_PER_CANDLE :: 96

FOOTPRINT_FIELD_BUY_VOLUME    :: 0
FOOTPRINT_FIELD_SELL_VOLUME   :: 1
FOOTPRINT_FIELD_IMBALANCE     :: 2
FOOTPRINT_FIELD_IS_POC        :: 3

FOOTPRINT_FIELD_COUNT :: 4

FootprintBuffer :: struct {
    cellsFlatF32:             [^]f32,
    candleCapacity:           i32,
    priceCellsPerCandle:      i32,
    priceStepUsdPerCell:      f64,
    referenceMinPricePerCandle: [^]f64,
}

footprint_buffer_init :: proc "contextless" (
    buffer:                          ^FootprintBuffer,
    storage_cells:                   [^]f32,
    reference_min_price_storage:     [^]f64,
    candle_capacity:                 i32,
    price_cells_per_candle:          i32,
    price_step_usd_per_cell:         f64,
) {
    buffer.cellsFlatF32 = storage_cells
    buffer.candleCapacity = candle_capacity
    buffer.priceCellsPerCandle = price_cells_per_candle
    buffer.priceStepUsdPerCell = price_step_usd_per_cell
    buffer.referenceMinPricePerCandle = reference_min_price_storage
}

@(private)
cell_base_index :: #force_inline proc "contextless" (
    buffer: ^FootprintBuffer, candle_index, price_cell_index: i32,
) -> i32 {
    return (candle_index * buffer.priceCellsPerCandle + price_cell_index) * FOOTPRINT_FIELD_COUNT
}

footprint_reset_candle :: proc "contextless" (buffer: ^FootprintBuffer, candle_index: i32) {
    for price_cell_index: i32 = 0; price_cell_index < buffer.priceCellsPerCandle; price_cell_index += 1 {
        base := cell_base_index(buffer, candle_index, price_cell_index)
        buffer.cellsFlatF32[base + FOOTPRINT_FIELD_BUY_VOLUME]  = 0
        buffer.cellsFlatF32[base + FOOTPRINT_FIELD_SELL_VOLUME] = 0
        buffer.cellsFlatF32[base + FOOTPRINT_FIELD_IMBALANCE]   = 0
        buffer.cellsFlatF32[base + FOOTPRINT_FIELD_IS_POC]      = 0
    }
}

footprint_record_aggregate_trade :: proc "contextless" (
    buffer:        ^FootprintBuffer,
    candle_index:  i32,
    trade_price:   f64,
    trade_volume:  f32,
    is_buyer_maker: bool, // Binance flag: true → seller was aggressor
) {
    reference_min_price := buffer.referenceMinPricePerCandle[candle_index]
    price_cell_index := i32((trade_price - reference_min_price) / buffer.priceStepUsdPerCell)
    if price_cell_index < 0 || price_cell_index >= buffer.priceCellsPerCandle { return }
    base := cell_base_index(buffer, candle_index, price_cell_index)
    if is_buyer_maker {
        buffer.cellsFlatF32[base + FOOTPRINT_FIELD_SELL_VOLUME] += trade_volume
    } else {
        buffer.cellsFlatF32[base + FOOTPRINT_FIELD_BUY_VOLUME]  += trade_volume
    }
}

footprint_finalize_candle :: proc "contextless" (buffer: ^FootprintBuffer, candle_index: i32) {
    point_of_control_cell_index: i32 = 0
    point_of_control_volume: f32 = 0
    for price_cell_index: i32 = 0; price_cell_index < buffer.priceCellsPerCandle; price_cell_index += 1 {
        base := cell_base_index(buffer, candle_index, price_cell_index)
        buy_volume  := buffer.cellsFlatF32[base + FOOTPRINT_FIELD_BUY_VOLUME]
        sell_volume := buffer.cellsFlatF32[base + FOOTPRINT_FIELD_SELL_VOLUME]
        total_volume := buy_volume + sell_volume
        imbalance: f32 = 0
        if total_volume > 0 {
            imbalance = (buy_volume - sell_volume) / total_volume
        }
        buffer.cellsFlatF32[base + FOOTPRINT_FIELD_IMBALANCE] = imbalance
        if total_volume > point_of_control_volume {
            point_of_control_volume = total_volume
            point_of_control_cell_index = price_cell_index
        }
    }
    if point_of_control_volume > 0 {
        poc_base := cell_base_index(buffer, candle_index, point_of_control_cell_index)
        buffer.cellsFlatF32[poc_base + FOOTPRINT_FIELD_IS_POC] = 1.0
    }
}
