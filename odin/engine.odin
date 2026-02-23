package engine

// ═══════════════════════════════════════════════════════════════
//  WebGL2 Chart Engine — Odin → WebAssembly (freestanding)
//  Viewport-aware rendering: vis_start..vis_end candle range
//  Y-axis: auto-fit with optional scale/offset override
// ═══════════════════════════════════════════════════════════════

MAX_INSTANCES :: 20_000
MAX_CANDLES   :: 1500
CANDLE_FIELDS :: 7
MAX_BOOK      :: 1024
LIQ_CAP       :: 600
LIQ_FIELDS    :: 4

POS_OFFSET     :: 0x10000
COL_OFFSET     :: 0x5E200
LUT_OFFSET     :: 0xAC400
CANDLE_OFFSET  :: 0xAC800
EMA9_OFFSET    :: 0xC1020
EMA21_OFFSET   :: 0xC3F00
LIQ_OFFSET     :: 0xC6DE0
BID_P_OFFSET   :: 0xCB860
BID_Q_OFFSET   :: 0xCD860
ASK_P_OFFSET   :: 0xCF860
ASK_Q_OFFSET   :: 0xD1860

candle_count:  i32
bid_count:     i32
ask_count:     i32
liq_count:     i32
mid_price:     f64
global_peak:   f64
ema9_val:      f64
ema21_val:     f64

out_min_price: f64
out_max_price: f64
out_mid_price: f64

EMA9_K  :: 2.0 / 10.0
EMA21_K :: 2.0 / 22.0

@(private) min_i32 :: proc "contextless" (a, b: i32) -> i32 { if a < b { return a }; return b }
@(private) max_i32 :: proc "contextless" (a, b: i32) -> i32 { if a > b { return a }; return b }
@(private) min_f64 :: proc "contextless" (a, b: f64) -> f64 { if a < b { return a }; return b }
@(private) max_f64 :: proc "contextless" (a, b: f64) -> f64 { if a > b { return a }; return b }

@(private) pos_buf    :: proc "contextless" () -> [^]f32 { return cast([^]f32) uintptr(POS_OFFSET) }
@(private) col_buf    :: proc "contextless" () -> [^]f32 { return cast([^]f32) uintptr(COL_OFFSET) }
@(private) lut        :: proc "contextless" () -> [^]u32 { return cast([^]u32) uintptr(LUT_OFFSET) }
@(private) candles    :: proc "contextless" () -> [^]f64 { return cast([^]f64) uintptr(CANDLE_OFFSET) }
@(private) ema9_buf   :: proc "contextless" () -> [^]f64 { return cast([^]f64) uintptr(EMA9_OFFSET) }
@(private) ema21_buf  :: proc "contextless" () -> [^]f64 { return cast([^]f64) uintptr(EMA21_OFFSET) }
@(private) liq_buf    :: proc "contextless" () -> [^]f64 { return cast([^]f64) uintptr(LIQ_OFFSET) }

@export get_pos_offset     :: proc "contextless" () -> i32 { return POS_OFFSET }
@export get_col_offset     :: proc "contextless" () -> i32 { return COL_OFFSET }
@export get_lut_offset     :: proc "contextless" () -> i32 { return LUT_OFFSET }
@export get_candle_offset  :: proc "contextless" () -> i32 { return CANDLE_OFFSET }
@export get_ema9_offset    :: proc "contextless" () -> i32 { return EMA9_OFFSET }
@export get_ema21_offset   :: proc "contextless" () -> i32 { return EMA21_OFFSET }
@export get_liq_offset     :: proc "contextless" () -> i32 { return LIQ_OFFSET }
@export get_bid_p_offset   :: proc "contextless" () -> i32 { return BID_P_OFFSET }
@export get_bid_q_offset   :: proc "contextless" () -> i32 { return BID_Q_OFFSET }
@export get_ask_p_offset   :: proc "contextless" () -> i32 { return ASK_P_OFFSET }
@export get_ask_q_offset   :: proc "contextless" () -> i32 { return ASK_Q_OFFSET }

@export get_candle_count :: proc "contextless" () -> i32 { return candle_count }
@export get_mid_price    :: proc "contextless" () -> f64 { return mid_price }
@export get_out_min      :: proc "contextless" () -> f64 { return out_min_price }
@export get_out_max      :: proc "contextless" () -> f64 { return out_max_price }
@export get_out_mid      :: proc "contextless" () -> f64 { return out_mid_price }

@export
init_lut :: proc "contextless" () {
    l := lut()
    for i := 0; i < 256; i += 1 {
        t := f64(i) / 255.0
        r, g, b: f64
        if t < 0.25 { s := t * 4.0; r = 6.0 + 8.0 * s; g = 10.0 + 40.0 * s; b = 30.0 + 100.0 * s }
        else if t < 0.5 { s := (t - 0.25) * 4.0; r = 14.0 + 30.0 * s; g = 50.0 + 80.0 * s; b = 130.0 + 40.0 * s }
        else if t < 0.75 { s := (t - 0.5) * 4.0; r = 44.0 + 180.0 * s; g = 130.0 + 80.0 * s; b = 170.0 - 120.0 * s }
        else { s := (t - 0.75) * 4.0; r = 224.0 + 31.0 * s; g = 210.0 + 45.0 * s; b = 50.0 + 205.0 * s }
        ri := u32(r) & 0xFF; gi := u32(g) & 0xFF; bi := u32(b) & 0xFF
        ai := u32(180 + (75 * i / 255))
        l[i] = ri | (gi << 8) | (bi << 16) | (ai << 24)
    }
    l[0] = 0; l[1] = 0
    global_peak = 1.0; mid_price = 0.0; candle_count = 0; bid_count = 0; ask_count = 0; liq_count = 0
}

@(private) c_ts    :: proc "contextless" (i: i32) -> f64 { return candles()[i * CANDLE_FIELDS] }
@(private) c_open  :: proc "contextless" (i: i32) -> f64 { return candles()[i * CANDLE_FIELDS + 1] }
@(private) c_high  :: proc "contextless" (i: i32) -> f64 { return candles()[i * CANDLE_FIELDS + 2] }
@(private) c_low   :: proc "contextless" (i: i32) -> f64 { return candles()[i * CANDLE_FIELDS + 3] }
@(private) c_close :: proc "contextless" (i: i32) -> f64 { return candles()[i * CANDLE_FIELDS + 4] }

@export set_candle_count :: proc "contextless" (n: i32) { candle_count = min_i32(n, MAX_CANDLES) }
@export set_book_counts :: proc "contextless" (bids: i32, asks: i32) { bid_count = min_i32(bids, MAX_BOOK); ask_count = min_i32(asks, MAX_BOOK) }
@export set_liq_count :: proc "contextless" (n: i32) { liq_count = min_i32(n, LIQ_CAP) }
@export set_mid_price :: proc "contextless" (p: f64) { mid_price = p }

@export recompute_ema :: proc "contextless" () {
    if candle_count == 0 { return }
    e9 := ema9_buf(); e21 := ema21_buf()
    ema9_val = c_close(0); ema21_val = c_close(0); e9[0] = ema9_val; e21[0] = ema21_val
    for i: i32 = 1; i < candle_count; i += 1 {
        c := c_close(i)
        ema9_val = c * EMA9_K + ema9_val * (1.0 - EMA9_K)
        ema21_val = c * EMA21_K + ema21_val * (1.0 - EMA21_K)
        e9[i] = ema9_val; e21[i] = ema21_val
    }
}

@export update_ema_last :: proc "contextless" () {
    if candle_count < 2 { return }
    idx := candle_count - 1; c := c_close(idx)
    ema9_val = c * EMA9_K + ema9_val * (1.0 - EMA9_K)
    ema21_val = c * EMA21_K + ema21_val * (1.0 - EMA21_K)
    ema9_buf()[idx] = ema9_val; ema21_buf()[idx] = ema21_val
}

@export
update_chart :: proc "contextless" (
    vis_start_f:   f64,
    vis_end_f:     f64,
    y_scale:       f64,
    y_offset:      f64,
    canvas_w:      f32,
    canvas_h:      f32,
    margin_right:  f32,
    margin_bottom: f32,
    dpr:           f32,
    tf_ms:         f64,
) -> i32 {
    if candle_count < 2 { return 0 }

    pw := canvas_w - margin_right * dpr
    ph := canvas_h - margin_bottom * dpr
    if pw < 10 || ph < 10 { return 0 }

    candle_ms := tf_ms
    if candle_ms < 1000 { candle_ms = 60000 }

    v_s := i32(vis_start_f)
    v_e := i32(vis_end_f)
    if v_s < 0 { v_s = 0 }
    if v_e > candle_count { v_e = candle_count }
    vis_len := v_e - v_s
    if vis_len < 1 { return 0 }

    data_hi := c_high(v_s)
    data_lo := c_low(v_s)
    for i := v_s + 1; i < v_e; i += 1 {
        h := c_high(i); l := c_low(i)
        if h > data_hi { data_hi = h }
        if l < data_lo { data_lo = l }
    }
    data_range := data_hi - data_lo
    if data_range <= 0 { data_range = 1 }
    padding := data_range * 0.05
    center := (data_hi + data_lo) * 0.5 + y_offset
    half_range := (data_range + padding * 2) * 0.5 * y_scale

    min_p := center - half_range
    max_p := center + half_range
    price_range := max_p - min_p
    if price_range <= 0 { return 0 }
    inv_pr := f64(ph) / price_range

    out_min_price = min_p
    out_max_price = max_p
    out_mid_price = c_close(min_i32(v_e - 1, candle_count - 1))

    candle_w_f := (f64(pw) / f64(vis_len)) * 0.75
    if candle_w_f < 1 { candle_w_f = 1 }
    max_cw := f64(20 * dpr)
    if candle_w_f > max_cw { candle_w_f = max_cw }
    cw := f32(candle_w_f)
    half_cw := cw * 0.5
    x_step := f64(pw) / f64(vis_len)

    pos := pos_buf(); col := col_buf()
    inst: i32 = 0; max_inst: i32 = MAX_INSTANCES - 10

    wick_w := f32(dpr)
    if wick_w < 1 { wick_w = 1 }

    for i := v_s; i < v_e && inst < max_inst; i += 1 {
        ci := i - v_s
        x_f := f32(f64(ci) * x_step + x_step * 0.5)
        hi := c_high(i); lo := c_low(i)
        y_hi := f32((max_p - hi) * inv_pr); y_lo := f32((max_p - lo) * inv_pr)
        bull := c_close(i) >= c_open(i)
        wick_h := y_lo - y_hi
        if wick_h < 1 { wick_h = 1 }
        off := inst * 4
        pos[off] = x_f - wick_w * 0.5; pos[off+1] = y_hi; pos[off+2] = wick_w; pos[off+3] = wick_h
        if bull { col[off] = 0.239; col[off+1] = 0.788; col[off+2] = 0.522; col[off+3] = 0.7 }
        else    { col[off] = 0.937; col[off+1] = 0.310; col[off+2] = 0.376; col[off+3] = 0.7 }
        inst += 1
    }

    for i := v_s; i < v_e && inst < max_inst; i += 1 {
        ci := i - v_s
        x_f := f32(f64(ci) * x_step + x_step * 0.5)
        o := c_open(i); c := c_close(i); bull := c >= o
        y_top, y_bot: f32
        if bull { y_top = f32((max_p - c) * inv_pr); y_bot = f32((max_p - o) * inv_pr) }
        else    { y_top = f32((max_p - o) * inv_pr); y_bot = f32((max_p - c) * inv_pr) }
        bh := y_bot - y_top
        if bh < 1 { bh = 1 }
        off := inst * 4
        pos[off] = x_f - half_cw; pos[off+1] = y_top; pos[off+2] = cw; pos[off+3] = bh
        if bull { col[off] = 0.239; col[off+1] = 0.788; col[off+2] = 0.522; col[off+3] = 1.0 }
        else    { col[off] = 0.937; col[off+1] = 0.310; col[off+2] = 0.376; col[off+3] = 1.0 }
        inst += 1
    }

    lb := liq_buf()
    t0 := c_ts(v_s); t1 := c_ts(v_e - 1)
    t_range := t1 - t0
    if t_range < candle_ms { t_range = candle_ms }
    for i: i32 = 0; i < liq_count && inst < max_inst; i += 1 {
        base := int(i) * LIQ_FIELDS
        lt := lb[base]; lp := lb[base+1]; lq := lb[base+2]; ls := lb[base+3]
        if lt < t0 || lt > t1 + candle_ms { continue }
        x_f := f32((lt - t0) / t_range * f64(pw))
        y_f := f32((max_p - lp) * inv_pr)
        if x_f < 0 || x_f > pw || y_f < 0 || y_f > ph { continue }
        s := f32(3.0 * f64(dpr))
        sz := lq * lp / 1000.0
        if sz > 9 { s = f32(6.0 * f64(dpr)) }
        if sz > 100 { s = f32(10.0 * f64(dpr)) }
        max_s := f32(12 * dpr)
        if s > max_s { s = max_s }
        off := inst * 4
        pos[off] = x_f - s * 0.5; pos[off+1] = y_f - s * 0.5; pos[off+2] = s; pos[off+3] = s
        if ls == 1.0 { col[off] = 0.937; col[off+1] = 0.310; col[off+2] = 0.376; col[off+3] = 0.85 }
        else         { col[off] = 0.239; col[off+1] = 0.788; col[off+2] = 0.522; col[off+3] = 0.85 }
        inst += 1
    }

    return inst
}
