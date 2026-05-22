// Volume-Weighted Average Price layer.
//
// Computes daily / weekly / monthly VWAP plus ±1σ bands, anchored to UTC
// period boundaries. State machine accumulates a running sum that resets at
// each anchor, so we can seed forward from candle 0 even when the visible
// range starts mid-session.
package indicators

import "../data"

VwapAccumulator :: struct {
    sumPriceVolume:        f64,
    sumVolume:             f64,
    sumPriceVolumeSquared: f64,
}

VwapResultRow :: struct {
    dailyVwapPrice:        f64,
    weeklyVwapPrice:       f64,
    monthlyVwapPrice:      f64,
    dailyUpperBandPrice:   f64,
    dailyLowerBandPrice:   f64,
}

@(private="file")
accumulate_into :: #force_inline proc "contextless" (
    accumulator: ^VwapAccumulator,
    typical_price, volume_base: f64,
) {
    price_times_volume := typical_price * volume_base
    accumulator.sumPriceVolume        += price_times_volume
    accumulator.sumVolume             += volume_base
    accumulator.sumPriceVolumeSquared += typical_price * price_times_volume
}

@(private="file")
reset :: #force_inline proc "contextless" (accumulator: ^VwapAccumulator) {
    accumulator.sumPriceVolume = 0
    accumulator.sumVolume = 0
    accumulator.sumPriceVolumeSquared = 0
}

PeriodKeys :: struct {
    dayKey:   i64,
    weekKey:  i64,
    monthKey: i64,
}

compute_period_keys_utc :: proc "contextless" (timestamp_ms: f64) -> PeriodKeys {
    days_since_epoch := i64(timestamp_ms) / 86_400_000
    day_of_week := (days_since_epoch + 3) % 7
    if day_of_week < 0 { day_of_week += 7 }
    year, month, _ := gregorian_from_days_since_epoch(days_since_epoch)
    return {
        dayKey   = days_since_epoch,
        weekKey  = days_since_epoch - day_of_week,
        monthKey = i64(year) * 100 + i64(month),
    }
}

@(private="file")
gregorian_from_days_since_epoch :: proc "contextless" (
    days_since_epoch: i64,
) -> (year, month, day: i32) {
    shifted_days := days_since_epoch + 719468
    era: i64
    if shifted_days >= 0 {
        era = shifted_days / 146_097
    } else {
        era = (shifted_days - 146_096) / 146_097
    }
    day_of_era := shifted_days - era * 146_097
    year_of_era := (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365
    candidate_year := year_of_era + era * 400
    day_of_year := day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100)
    month_position := (5 * day_of_year + 2) / 153
    day_of_month := day_of_year - (153 * month_position + 2) / 5 + 1
    candidate_month := month_position + 3
    if month_position >= 10 {
        candidate_month = month_position - 9
    }
    if candidate_month <= 2 { candidate_year += 1 }
    return i32(candidate_year), i32(candidate_month), i32(day_of_month)
}

VwapRollingState :: struct {
    dailyAccumulator:     VwapAccumulator,
    weeklyAccumulator:    VwapAccumulator,
    monthlyAccumulator:   VwapAccumulator,
    previousDayKey:       i64,
    previousWeekKey:      i64,
    previousMonthKey:     i64,
}

vwap_rolling_state_init :: proc "contextless" (state: ^VwapRollingState) {
    state^ = VwapRollingState{
        previousDayKey   = -1,
        previousWeekKey  = -1,
        previousMonthKey = -1,
    }
}

// Update the accumulators with one candle. Returns whether a daily reset
// occurred so the caller can break a polyline draw segment.
vwap_rolling_advance :: proc "contextless" (
    state: ^VwapRollingState,
    store: ^data.CandleStore,
    candle_index: i32,
) -> (did_reset_daily, did_reset_weekly, did_reset_monthly: bool) {
    if candle_index < 0 || candle_index >= data.candle_store_count(store) { return }
    timestamp_ms := data.candle_field(store, candle_index, data.CANDLE_FIELD_TIMESTAMP_MS)
    period_keys := compute_period_keys_utc(timestamp_ms)

    if period_keys.dayKey != state.previousDayKey {
        reset(&state.dailyAccumulator)
        state.previousDayKey = period_keys.dayKey
        did_reset_daily = true
    }
    if period_keys.weekKey != state.previousWeekKey {
        reset(&state.weeklyAccumulator)
        state.previousWeekKey = period_keys.weekKey
        did_reset_weekly = true
    }
    if period_keys.monthKey != state.previousMonthKey {
        reset(&state.monthlyAccumulator)
        state.previousMonthKey = period_keys.monthKey
        did_reset_monthly = true
    }

    volume_base := data.candle_field(store, candle_index, data.CANDLE_FIELD_VOLUME)
    if volume_base <= 0 { return }

    high_price  := data.candle_field(store, candle_index, data.CANDLE_FIELD_HIGH_PRICE)
    low_price   := data.candle_field(store, candle_index, data.CANDLE_FIELD_LOW_PRICE)
    close_price := data.candle_field(store, candle_index, data.CANDLE_FIELD_CLOSE_PRICE)
    typical_price := (high_price + low_price + close_price) / 3.0

    accumulate_into(&state.dailyAccumulator,   typical_price, volume_base)
    accumulate_into(&state.weeklyAccumulator,  typical_price, volume_base)
    accumulate_into(&state.monthlyAccumulator, typical_price, volume_base)
    return
}

// Seed a rolling state from candle 0 up to (but not including) `seed_until`.
// Used so the visible-window draw pass starts at the correct accumulator.
vwap_seed_until :: proc "contextless" (
    state: ^VwapRollingState,
    store: ^data.CandleStore,
    seed_until: i32,
) {
    candle_count := data.candle_store_count(store)
    upper := seed_until
    if upper > candle_count { upper = candle_count }
    for index: i32 = 0; index < upper; index += 1 {
        _, _, _ = vwap_rolling_advance(state, store, index)
    }
}

vwap_rolling_current :: proc "contextless" (state: ^VwapRollingState) -> VwapResultRow {
    row: VwapResultRow
    if state.dailyAccumulator.sumVolume > 0 {
        daily_price := state.dailyAccumulator.sumPriceVolume / state.dailyAccumulator.sumVolume
        row.dailyVwapPrice = daily_price
        variance := state.dailyAccumulator.sumPriceVolumeSquared / state.dailyAccumulator.sumVolume - daily_price * daily_price
        if variance < 0 { variance = 0 }
        standard_deviation := newton_sqrt(variance)
        row.dailyUpperBandPrice = daily_price + standard_deviation
        row.dailyLowerBandPrice = daily_price - standard_deviation
    }
    if state.weeklyAccumulator.sumVolume > 0 {
        row.weeklyVwapPrice = state.weeklyAccumulator.sumPriceVolume / state.weeklyAccumulator.sumVolume
    }
    if state.monthlyAccumulator.sumVolume > 0 {
        row.monthlyVwapPrice = state.monthlyAccumulator.sumPriceVolume / state.monthlyAccumulator.sumVolume
    }
    return row
}

@(private="file")
newton_sqrt :: #force_inline proc "contextless" (value: f64) -> f64 {
    if value <= 0 { return 0 }
    guess := value
    for _ in 0..<6 { guess = 0.5 * (guess + value / guess) }
    return guess
}
