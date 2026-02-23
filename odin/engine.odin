package engine

// ═══════════════════════════════════════════════════════════════
//  WebGL2 Chart Engine — Odin → WASM (freestanding, js_wasm32)
//
//  Architecture:
//  - 5000-candle shared buffer for deep history panning
//  - Stride-based OHLC aggregation for zoomed-out rendering
//  - Buffer-range rendering: WASM pre-computes a padded range,
//    GPU pans within it via u_camera_x uniform (zero WASM cost)
//  - ALL exported params are f64 for safe JS ↔ WASM ABI
// ═══════════════════════════════════════════════════════════════

MAX_INSTANCES :: 50_000
MAX_CANDLES   :: 5000
CANDLE_FIELDS :: 7
LIQ_CAP       :: 600
LIQ_FIELDS    :: 4

// ── Memory layout (50k instances) ──
// Region          Offset     Size (bytes)
// POS (f32×4)     0x10000    800,000   50k instances
// COL (f32×4)     0xD3500    800,000
// LUT (u32)       0x196A00     1,024   256 entries
// CANDLE (f64×7)  0x196E00   280,000   5000 candles
// EMA9 (f64)      0x1DB440    40,000
// EMA21 (f64)     0x1E5080    40,000
// LIQ (f64×4)     0x1EECC0    19,200   600 events
// Peak usage:     0x1F3600 ≈ 2,045,440 B → 32 pages
// Target: 36 pages (2,359,296 B) for headroom

POS_OFFSET    :: 0x10000
COL_OFFSET    :: 0xD3500
LUT_OFFSET    :: 0x196A00
CANDLE_OFFSET :: 0x196E00
EMA9_OFFSET   :: 0x1DB440
EMA21_OFFSET  :: 0x1E5080
LIQ_OFFSET    :: 0x1EECC0

// ── Mutable globals ──
candle_count:  i32
liq_count:     i32
mid_price:     f64
ema9_val:      f64
ema21_val:     f64
out_min_price: f64
out_max_price: f64
out_mid_price: f64
buf_range_start: i32
buf_range_end:   i32
buf_x_step:      f32
buf_inst_count:  i32

EMA9_K  :: 2.0 / 10.0
EMA21_K :: 2.0 / 22.0

// ── Tiny helpers (inlined by compiler) ──
@(private) clamp_i32 :: proc "contextless" (v, lo, hi: i32) -> i32 {
    if v < lo { return lo }; if v > hi { return hi }; return v
}

// ── Memory accessors ──
@(private) pos_buf   :: proc "contextless" () -> [^]f32 { return cast([^]f32) uintptr(POS_OFFSET) }
@(private) col_buf   :: proc "contextless" () -> [^]f32 { return cast([^]f32) uintptr(COL_OFFSET) }
@(private) lut       :: proc "contextless" () -> [^]u32 { return cast([^]u32) uintptr(LUT_OFFSET) }
@(private) candles   :: proc "contextless" () -> [^]f64 { return cast([^]f64) uintptr(CANDLE_OFFSET) }
@(private) ema9_buf  :: proc "contextless" () -> [^]f64 { return cast([^]f64) uintptr(EMA9_OFFSET) }
@(private) ema21_buf :: proc "contextless" () -> [^]f64 { return cast([^]f64) uintptr(EMA21_OFFSET) }
@(private) liq_buf   :: proc "contextless" () -> [^]f64 { return cast([^]f64) uintptr(LIQ_OFFSET) }

// ── Candle field accessors (bounds assumed by caller) ──
@(private) c_ts    :: proc "contextless" (i: i32) -> f64 { return candles()[i * CANDLE_FIELDS] }
@(private) c_open  :: proc "contextless" (i: i32) -> f64 { return candles()[i * CANDLE_FIELDS + 1] }
@(private) c_high  :: proc "contextless" (i: i32) -> f64 { return candles()[i * CANDLE_FIELDS + 2] }
@(private) c_low   :: proc "contextless" (i: i32) -> f64 { return candles()[i * CANDLE_FIELDS + 3] }
@(private) c_close :: proc "contextless" (i: i32) -> f64 { return candles()[i * CANDLE_FIELDS + 4] }

// ── Offset getters for WasmBridge ──
@export get_pos_offset    :: proc "contextless" () -> i32 { return POS_OFFSET }
@export get_col_offset    :: proc "contextless" () -> i32 { return COL_OFFSET }
@export get_candle_offset :: proc "contextless" () -> i32 { return CANDLE_OFFSET }
@export get_ema9_offset   :: proc "contextless" () -> i32 { return EMA9_OFFSET }
@export get_ema21_offset  :: proc "contextless" () -> i32 { return EMA21_OFFSET }
@export get_liq_offset    :: proc "contextless" () -> i32 { return LIQ_OFFSET }

// ── State getters ──
@export get_candle_count    :: proc "contextless" () -> i32 { return candle_count }
@export get_mid_price       :: proc "contextless" () -> f64 { return mid_price }
@export get_out_min         :: proc "contextless" () -> f64 { return out_min_price }
@export get_out_max         :: proc "contextless" () -> f64 { return out_max_price }
@export get_out_mid         :: proc "contextless" () -> f64 { return out_mid_price }
@export get_buf_range_start :: proc "contextless" () -> i32 { return buf_range_start }
@export get_buf_range_end   :: proc "contextless" () -> i32 { return buf_range_end }
@export get_buf_x_step      :: proc "contextless" () -> f32 { return buf_x_step }
@export get_buf_inst_count  :: proc "contextless" () -> i32 { return buf_inst_count }

// ── Setters ──
@export set_candle_count :: proc "contextless" (n: i32) { candle_count = clamp_i32(n, 0, MAX_CANDLES) }
@export set_liq_count    :: proc "contextless" (n: i32) { liq_count = clamp_i32(n, 0, LIQ_CAP) }
@export set_mid_price    :: proc "contextless" (p: f64) { mid_price = p }

// ── LUT init ──
@export
init_lut :: proc "contextless" () {
    l := lut()
    for i := 0; i < 256; i += 1 {
        t := f64(i) / 255.0
        r, g, b: f64
        if t < 0.25      { s := t * 4.0;          r = 6+8*s;    g = 10+40*s;   b = 30+100*s }
        else if t < 0.5   { s := (t - 0.25) * 4.0; r = 14+30*s;  g = 50+80*s;   b = 130+40*s }
        else if t < 0.75  { s := (t - 0.5) * 4.0;  r = 44+180*s; g = 130+80*s;  b = 170-120*s }
        else               { s := (t - 0.75) * 4.0; r = 224+31*s; g = 210+45*s;  b = 50+205*s }
        ri := u32(r) & 0xFF; gi := u32(g) & 0xFF; bi := u32(b) & 0xFF
        ai := u32(180 + (75 * i / 255))
        l[i] = ri | (gi << 8) | (bi << 16) | (ai << 24)
    }
    l[0] = 0; l[1] = 0
    mid_price = 0; candle_count = 0; liq_count = 0
}

// ── EMA ──
@export recompute_ema :: proc "contextless" () {
    if candle_count < 1 { return }
    e9 := ema9_buf(); e21 := ema21_buf()
    ema9_val = c_close(0); ema21_val = ema9_val
    e9[0] = ema9_val; e21[0] = ema21_val
    for i: i32 = 1; i < candle_count; i += 1 {
        c := c_close(i)
        ema9_val  = c * EMA9_K  + ema9_val  * (1.0 - EMA9_K)
        ema21_val = c * EMA21_K + ema21_val * (1.0 - EMA21_K)
        e9[i] = ema9_val; e21[i] = ema21_val
    }
}

@export update_ema_last :: proc "contextless" () {
    if candle_count < 2 { return }
    idx := candle_count - 1; c := c_close(idx)
    ema9_val  = c * EMA9_K  + ema9_val  * (1.0 - EMA9_K)
    ema21_val = c * EMA21_K + ema21_val * (1.0 - EMA21_K)
    ema9_buf()[idx] = ema9_val; ema21_buf()[idx] = ema21_val
}

// ── Stride-aware OHLC aggregation ──
// Merges [start .. min(start+stride, candle_count)) into one OHLC bar.
@(private)
agg_ohlc :: proc "contextless" (start, stride: i32) -> (o, h, l, c: f64) {
    if start < 0 || start >= candle_count {
        return 0, 0, 0, 0
    }
    end := start + stride
    if end > candle_count { end = candle_count }
    if end <= start { end = start + 1 }
    o = c_open(start); h = c_high(start); l = c_low(start)
    last := end - 1
    if last >= candle_count { last = candle_count - 1 }
    if last < 0 { last = 0 }
    c = c_close(last)
    for i := start + 1; i < end; i += 1 {
        hi := c_high(i); lo := c_low(i)
        if hi > h { h = hi }
        if lo < l { l = lo }
    }
    return
}

// ═══════════════════════════════════════════════════════════════
//  MAIN RENDER FUNCTION — Buffer-range + stride aggregation
//
//  Computes screen-space quads for candles in [bufStart..bufEnd)
//  using Y-axis auto-fit from [visStart..visEnd). Writes into
//  shared POS/COL buffers for zero-copy WebGL upload.
// ═══════════════════════════════════════════════════════════════
@export
update_chart_buffered :: proc "contextless" (
    buf_start_f, buf_end_f:     f64,
    vis_start_f, vis_end_f:     f64,
    y_scale, y_offset:          f64,
    canvas_w, canvas_h:         f64,
    margin_right, margin_bottom: f64,
    dpr_f, tf_ms, stride_f:     f64,
) -> i32 {
    if candle_count < 2 { return 0 }

    dpr := f32(dpr_f)
    pw  := f32(canvas_w) - f32(margin_right) * dpr
    ph  := f32(canvas_h) - f32(margin_bottom) * dpr
    if pw < 10 || ph < 10 { return 0 }

    candle_ms := tf_ms
    if candle_ms < 1000 { candle_ms = 60000 }

    stride := clamp_i32(i32(stride_f), 1, 256)
    max_idx := candle_count - 1

    b_s := clamp_i32(i32(buf_start_f), 0, max_idx)
    b_e := clamp_i32(i32(buf_end_f),   0, candle_count)
    v_s := clamp_i32(i32(vis_start_f),  0, max_idx)
    v_e := clamp_i32(i32(vis_end_f),    1, candle_count)

    b_s = (b_s / stride) * stride   // align to stride boundary
    if b_e <= b_s { return 0 }
    if v_e <= v_s { return 0 }

    vis_len := v_e - v_s
    buf_len := b_e - b_s
    vis_agg := (vis_len + stride - 1) / stride
    if vis_agg < 1 { vis_agg = 1 }

    // ── Y-axis: auto-fit from visible range ──
    data_hi := c_high(v_s); data_lo := c_low(v_s)
    for i := v_s + 1; i < v_e; i += 1 {
        hi := c_high(i); lo := c_low(i)
        if hi > data_hi { data_hi = hi }
        if lo < data_lo { data_lo = lo }
    }
    data_range := data_hi - data_lo
    if data_range <= 0 { data_range = 1 }
    pad := data_range * 0.05
    center     := (data_hi + data_lo) * 0.5 + y_offset
    half_range := (data_range + pad * 2) * 0.5 * y_scale
    min_p := center - half_range
    max_p := center + half_range
    price_range := max_p - min_p
    if price_range <= 0 { return 0 }
    inv_pr := f64(ph) / price_range

    out_min_price = min_p
    out_max_price = max_p
    out_mid_price = c_close(clamp_i32(v_e - 1, 0, max_idx))

    // ── X layout (TradingView-style proportional sizing) ──
    x_step := f64(pw) / f64(vis_agg)

    // Body: 60% of slot width, capped so candles never become absurdly wide
    cw_f := x_step * 0.6
    if cw_f < 1 { cw_f = 1 }
    max_cw := f64(14 * dpr)
    if cw_f > max_cw { cw_f = max_cw }
    cw := f32(cw_f); half_cw := cw * 0.5

    // Wick: proportional to body width (like TradingView), min 1px, max ~2px
    wk_w := cw * 0.15
    if wk_w < dpr { wk_w = dpr }
    max_wk := dpr * 2.0
    if wk_w > max_wk { wk_w = max_wk }

    buf_range_start = b_s
    buf_range_end   = b_e
    buf_x_step      = f32(x_step)

    pos := pos_buf(); col := col_buf()
    inst: i32 = 0
    limit: i32 = MAX_INSTANCES - 10

    // ── Pass 1: wicks ──
    for raw := b_s; raw < b_e && raw < candle_count && inst < limit; raw += stride {
        ao, ah, al, ac := agg_ohlc(raw, stride)
        agg_i  := (raw - b_s) / stride
        x_raw  := f32(f64(agg_i) * x_step + x_step * 0.5)
        x      := f32(i32(x_raw + 0.5))  // snap to pixel grid
        y_hi   := f32(i32(f32((max_p - ah) * inv_pr) + 0.5))
        y_lo   := f32(i32(f32((max_p - al) * inv_pr) + 0.5))
        wh     := y_lo - y_hi; if wh < 1 { wh = 1 }
        bull   := ac >= ao
        off    := inst * 4
        wk_x   := f32(i32(x - wk_w*0.5 + 0.5))
        pos[off] = wk_x; pos[off+1] = y_hi; pos[off+2] = wk_w; pos[off+3] = wh
        if bull { col[off]=0.239; col[off+1]=0.788; col[off+2]=0.522; col[off+3]=1.0 }
        else    { col[off]=0.937; col[off+1]=0.310; col[off+2]=0.376; col[off+3]=1.0 }
        inst += 1
    }

    // ── Pass 2: bodies ──
    for raw := b_s; raw < b_e && raw < candle_count && inst < limit; raw += stride {
        ao, _, _, ac := agg_ohlc(raw, stride)
        bull  := ac >= ao
        agg_i := (raw - b_s) / stride
        x_raw := f32(f64(agg_i) * x_step + x_step * 0.5)
        x     := f32(i32(x_raw + 0.5))
        y_top, y_bot: f32
        if bull { y_top = f32((max_p - ac) * inv_pr); y_bot = f32((max_p - ao) * inv_pr) }
        else    { y_top = f32((max_p - ao) * inv_pr); y_bot = f32((max_p - ac) * inv_pr) }
        // Snap to pixel grid: floor top, ceil bottom → no sub-pixel gaps
        yt := f32(i32(y_top))
        yb := f32(i32(y_bot + 1.0))
        bh := yb - yt; if bh < 1 { bh = 1 }
        off := inst * 4
        bx  := f32(i32(x - half_cw + 0.5))
        pos[off] = bx; pos[off+1] = yt; pos[off+2] = cw; pos[off+3] = bh
        if bull { col[off]=0.239; col[off+1]=0.788; col[off+2]=0.522; col[off+3]=1.0 }
        else    { col[off]=0.937; col[off+1]=0.310; col[off+2]=0.376; col[off+3]=1.0 }
        inst += 1
    }

    // ── Liquidation markers ──
    if liq_count > 0 && b_s < candle_count && buf_len > 0 {
        t0 := c_ts(b_s)
        t1 := c_ts(clamp_i32(b_e - 1, 0, max_idx))
        t_range := t1 - t0; if t_range < candle_ms { t_range = candle_ms }
        buf_agg := (buf_len + stride - 1) / stride
        if buf_agg < 1 { buf_agg = 1 }
        for i: i32 = 0; i < liq_count && inst < limit; i += 1 {
            base := int(i) * LIQ_FIELDS
            lt := liq_buf()[base]; lp := liq_buf()[base+1]
            lq := liq_buf()[base+2]; ls := liq_buf()[base+3]
            if lt < t0 || lt > t1 + candle_ms { continue }
            xf := f32((lt - t0) / t_range * f64(buf_agg) * x_step)
            yf := f32((max_p - lp) * inv_pr)
            if yf < 0 || yf > ph { continue }
            sz := lq * lp / 1000.0
            s := f32(3 * dpr)
            if sz > 9   { s = f32(6 * dpr) }
            if sz > 100 { s = f32(10 * dpr) }
            ms := f32(12 * dpr); if s > ms { s = ms }
            off := inst * 4
            pos[off] = xf - s*0.5; pos[off+1] = yf - s*0.5; pos[off+2] = s; pos[off+3] = s
            if ls == 1.0 { col[off]=0.937; col[off+1]=0.310; col[off+2]=0.376; col[off+3]=0.85 }
            else         { col[off]=0.239; col[off+1]=0.788; col[off+2]=0.522; col[off+3]=0.85 }
            inst += 1
        }
    }

    buf_inst_count = inst
    return inst
}
