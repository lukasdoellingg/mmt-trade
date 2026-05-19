package engine

import "core:math"

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
vwap_d_price:    f64
vwap_w_price:    f64
vwap_m_price:    f64
vwap_d_upper:    f64
vwap_d_lower:    f64
render_flags:    i32

RENDER_VWAP_D     :: 1
RENDER_VWAP_W     :: 2
RENDER_VWAP_M     :: 4
RENDER_VWAP_BANDS :: 8
RENDER_EMA        :: 16
RENDER_LIQ        :: 32

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
@(private) c_vol   :: proc "contextless" (i: i32) -> f64 { return candles()[i * CANDLE_FIELDS + 5] }

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
@export get_vwap_d          :: proc "contextless" () -> f64 { return vwap_d_price }
@export get_vwap_w          :: proc "contextless" () -> f64 { return vwap_w_price }
@export get_vwap_m          :: proc "contextless" () -> f64 { return vwap_m_price }
@export get_vwap_d_upper    :: proc "contextless" () -> f64 { return vwap_d_upper }
@export get_vwap_d_lower    :: proc "contextless" () -> f64 { return vwap_d_lower }

// ── Setters ──
@export set_candle_count :: proc "contextless" (n: i32) { candle_count = clamp_i32(n, 0, MAX_CANDLES) }
@export set_liq_count    :: proc "contextless" (n: i32) { liq_count = clamp_i32(n, 0, LIQ_CAP) }
@export set_mid_price    :: proc "contextless" (p: f64) { mid_price = p }
@export set_render_flags :: proc "contextless" (f: i32) { render_flags = f }

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
    render_flags = RENDER_VWAP_D | RENDER_VWAP_W | RENDER_VWAP_M | RENDER_VWAP_BANDS | RENDER_EMA | RENDER_LIQ
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

// ── Date helpers (UTC) ──
@(private)
civil_from_days :: proc "contextless" (z0: i64) -> (year, month, day: i32) {
    z := z0 + 719468
    era: i64
    if z >= 0 { era = z / 146097 } else { era = (z - 146096) / 146097 }
    doe := z - era * 146097
    yoe := (doe - doe/1460 + doe/36524 - doe/146096) / 365
    y := yoe + era * 400
    doy := doe - (365*yoe + yoe/4 - yoe/100)
    mp := (5*doy + 2) / 153
    d := doy - (153*mp + 2) / 5 + 1
    m := mp + 3
    if mp >= 10 { m = mp - 9 }
    if m <= 2 { y += 1 }
    year = i32(y)
    month = i32(m)
    day = i32(d)
    return
}

VwapAccum :: struct {
    num: f64,
    den: f64,
    num2: f64,
}

// Accumulate one candle into D/W/M VWAP buckets (UTC period resets).
@(private)
accumulate_vwap_candle :: proc "contextless" (
    i: i32,
    day_acc, week_acc, month_acc: ^VwapAccum,
    last_day, last_week, last_month: ^i64,
) {
    if i < 0 || i >= candle_count { return }
    ts := c_ts(i)
    day_key, week_key, month_key := period_keys(ts)
    if day_key != last_day^ {
        day_acc^ = VwapAccum{}
        last_day^ = day_key
    }
    if week_key != last_week^ {
        week_acc^ = VwapAccum{}
        last_week^ = week_key
    }
    if month_key != last_month^ {
        month_acc^ = VwapAccum{}
        last_month^ = month_key
    }
    v := c_vol(i)
    if v <= 0 { return }
    tp := (c_high(i) + c_low(i) + c_close(i)) / 3.0
    tpv := tp * v
    day_acc.num += tpv; day_acc.den += v; day_acc.num2 += tp * tpv
    week_acc.num += tpv; week_acc.den += v
    month_acc.num += tpv; month_acc.den += v
}

// Seed VWAP state from candle 0 .. until-1 so draw pass at b_s is correct mid-session.
@(private)
seed_vwap_until :: proc "contextless" (
    until: i32,
    day_acc, week_acc, month_acc: ^VwapAccum,
    last_day, last_week, last_month: ^i64,
) {
    if until <= 0 { return }
    for i: i32 = 0; i < until && i < candle_count; i += 1 {
        accumulate_vwap_candle(i, day_acc, week_acc, month_acc, last_day, last_week, last_month)
    }
}

// Last visible-bar VWAP levels (for Y-axis auto-fit before draw pass).
@(private)
visible_vwap_at :: proc "contextless" (end_i: i32) -> (d, w, m: f64) {
    if end_i < 0 || end_i >= candle_count { return 0, 0, 0 }
    day_acc := VwapAccum{}
    week_acc := VwapAccum{}
    month_acc := VwapAccum{}
    last_day: i64 = -1
    last_week: i64 = -1
    last_month: i64 = -1
    for i: i32 = 0; i <= end_i; i += 1 {
        accumulate_vwap_candle(i, &day_acc, &week_acc, &month_acc, &last_day, &last_week, &last_month)
    }
    d = 0; w = 0; m = 0
    if day_acc.den > 0 { d = day_acc.num / day_acc.den }
    if week_acc.den > 0 { w = week_acc.num / week_acc.den }
    if month_acc.den > 0 { m = month_acc.num / month_acc.den }
    return
}

@(private)
period_keys :: proc "contextless" (ts_ms: f64) -> (day_key, week_key, month_key: i64) {
    d := i64(ts_ms) / 86_400_000
    dow := (d + 3) % 7 // Monday=0 ... Sunday=6
    if dow < 0 { dow += 7 }
    day_key = d
    week_key = d - dow
    y, m, _ := civil_from_days(d)
    month_key = i64(y) * 100 + i64(m)
    return
}

LineState :: struct {
    has_prev: bool,
    prev_x: f32,
    prev_y: f32,
}

@(private)
append_rect :: proc "contextless" (
    pos, col: [^]f32,
    inst: ^i32,
    limit: i32,
    x, y, w, h, r, g, b, a: f32,
) -> bool {
    if inst^ >= limit { return false }
    ww := w
    hh := h
    if ww < 1 { ww = 1 }
    if hh < 1 { hh = 1 }
    off := inst^ * 4
    pos[off] = x
    pos[off+1] = y
    pos[off+2] = ww
    pos[off+3] = hh
    col[off] = r
    col[off+1] = g
    col[off+2] = b
    col[off+3] = a
    inst^ += 1
    return true
}

@(private)
draw_vwap_point :: proc "contextless" (
    pos, col: [^]f32,
    inst: ^i32,
    limit: i32,
    st: ^LineState,
    x, y, th, r, g, b, a: f32,
) {
    if st.has_prev {
        append_line_segment(pos, col, inst, limit, st.prev_x, st.prev_y, x, y, th, r, g, b, a)
    }
    st.prev_x = x; st.prev_y = y; st.has_prev = true
}

@(private)
append_line_segment :: proc "contextless" (
    pos, col: [^]f32,
    inst: ^i32,
    limit: i32,
    x0, y0, x1, y1, th, r, g, b, a: f32,
) {
    dx := x1 - x0
    dy := y1 - y0
    if dx < 0 { dx = -dx }
    if dy < 0 { dy = -dy }

    // Near-horizontal: single rect
    if dy < 1.5 {
        lx := x0; rx := x1
        if rx < lx { t := lx; lx = rx; rx = t }
        w := rx - lx
        if w < 1 { w = 1 }
        avg_y := (y0 + y1) * 0.5
        _ = append_rect(pos, col, inst, limit, lx, avg_y - th*0.5, w, th, r, g, b, a)
        return
    }

    // Near-vertical: single rect
    if dx < 1.5 {
        ty := y0; by := y1
        if by < ty { t := ty; ty = by; by = t }
        h := by - ty
        if h < 1 { h = 1 }
        avg_x := (x0 + x1) * 0.5
        _ = append_rect(pos, col, inst, limit, avg_x - th*0.5, ty, th, h, r, g, b, a)
        return
    }

    // Diagonal: subdivide into small rects along the longer axis
    steps := i32(dx)
    if i32(dy) > steps { steps = i32(dy) }
    seg_len := f32(4.0)  // each sub-segment covers ~4px
    n_segs := steps / i32(seg_len) + 1
    if n_segs < 2 { n_segs = 2 }
    if n_segs > 120 { n_segs = 120 }

    inv_n := 1.0 / f32(n_segs)
    for s: i32 = 0; s < n_segs && inst^ < limit; s += 1 {
        t0 := f32(s) * inv_n
        t1 := f32(s + 1) * inv_n
        sx := x0 + (x1 - x0) * t0
        sy := y0 + (y1 - y0) * t0
        ex := x0 + (x1 - x0) * t1
        ey := y0 + (y1 - y0) * t1
        lx := sx; rx := ex
        if rx < lx { t := lx; lx = rx; rx = t }
        ty := sy; by := ey
        if by < ty { t := ty; ty = by; by = t }
        rw := rx - lx
        rh := by - ty
        if rw < th { rw = th }
        if rh < th { rh = th }
        _ = append_rect(pos, col, inst, limit, lx, ty, rw, rh, r, g, b, a)
    }
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
    pad := data_range * 0.06
    if (render_flags & (RENDER_VWAP_D | RENDER_VWAP_W | RENDER_VWAP_M)) != 0 {
        vis_end_i := clamp_i32(v_e - 1, 0, max_idx)
        vd, vw, vm := visible_vwap_at(vis_end_i)
        if (render_flags & RENDER_VWAP_D) != 0 && vd > 0 {
            if vd > data_hi { data_hi = vd }
            if vd < data_lo { data_lo = vd }
        }
        if (render_flags & RENDER_VWAP_W) != 0 && vw > 0 {
            if vw > data_hi { data_hi = vw }
            if vw < data_lo { data_lo = vw }
        }
        if (render_flags & RENDER_VWAP_M) != 0 && vm > 0 {
            if vm > data_hi { data_hi = vm }
            if vm < data_lo { data_lo = vm }
        }
        data_range = data_hi - data_lo
        if data_range <= 0 { data_range = 1 }
    }
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
    // Bin liquidations by raw candle, then floor-divide to the aggregated
    // slot so X matches the candle body that contains the event.
    //
    //   raw_bin    = (lt - t0) / candle_ms
    //   slot       = floor(raw_bin / stride)
    //   x          = (slot + 0.5) * x_step   <- identical to candle wick/body
    if (render_flags & RENDER_LIQ) != 0 && liq_count > 0 && b_s < candle_count && buf_len > 0 {
        t0 := c_ts(b_s)
        t_last := c_ts(clamp_i32(b_e - 1, 0, max_idx))
        inv_stride := 1.0 / f64(stride)
        for i: i32 = 0; i < liq_count && inst < limit; i += 1 {
            base := int(i) * LIQ_FIELDS
            lt := liq_buf()[base]; lp := liq_buf()[base+1]
            lq := liq_buf()[base+2]; ls := liq_buf()[base+3]
            if lt < t0 || lt > t_last + candle_ms { continue }
            raw_bin_f := (lt - t0) / candle_ms
            slot_f := raw_bin_f * inv_stride
            xf := f32(slot_f * x_step + x_step * 0.5)
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

    // ── VWAP suite (daily/weekly/monthly, UTC anchors) — MMT.gg / TradingView style ──
    //
    // Sample VWAP/EMA at the **same X positions as the candle bodies** — one
    // sample per aggregated slot, placed at slot-centre `(agg_i + 0.5) * x_step`.
    //
    // The volume accumulator still advances per raw candle so the daily/weekly/
    // monthly period resets land exactly on the right candle. But we only emit
    // a line point when we cross into a new slot (or hit a period reset, or
    // reach the buffer's last raw). This guarantees pixel-perfect alignment
    // between the VWAP line and the candle body it sits on, at any stride.
    vwap_d_price = 0; vwap_w_price = 0; vwap_m_price = 0
    vwap_d_upper = 0; vwap_d_lower = 0
    vwap_on := (render_flags & (RENDER_VWAP_D | RENDER_VWAP_W | RENDER_VWAP_M)) != 0
    if vwap_on && b_s < candle_count && inst < limit {
        line_th := dpr * 1.35
        if line_th < 1.5 { line_th = 1.5 }
        band_th := line_th * 0.85
        if band_th < 1 { band_th = 1 }

        day_r, day_g, day_b, day_a         := f32(0.941), f32(0.757), f32(0.188), f32(0.92)
        week_r, week_g, week_b, week_a     := f32(0.937), f32(0.310), f32(0.557), f32(0.88)
        month_r, month_g, month_b, month_a := f32(0.247), f32(0.827), f32(0.894), f32(0.88)
        band_a := f32(0.42)

        last_day: i64 = -1
        last_week: i64 = -1
        last_month: i64 = -1

        day_acc := VwapAccum{}
        week_acc := VwapAccum{}
        month_acc := VwapAccum{}

        seed_vwap_until(b_s, &day_acc, &week_acc, &month_acc, &last_day, &last_week, &last_month)

        day_state := LineState{}
        week_state := LineState{}
        month_state := LineState{}
        day_up_st := LineState{}
        day_lo_st := LineState{}

        last_emitted_slot: i32 = -1
        for raw := b_s; raw < b_e && raw < candle_count; raw += 1 {
            if inst >= limit { break }
            prev_day := last_day
            prev_week := last_week
            prev_month := last_month
            accumulate_vwap_candle(raw, &day_acc, &week_acc, &month_acc, &last_day, &last_week, &last_month)
            if last_day != prev_day && prev_day >= 0 {
                day_state = LineState{}
                day_up_st = LineState{}
                day_lo_st = LineState{}
            }
            if last_week != prev_week && prev_week >= 0 { week_state = LineState{} }
            if last_month != prev_month && prev_month >= 0 { month_state = LineState{} }

            slot := (raw - b_s) / stride
            is_slot_last := raw == b_e - 1 || raw == candle_count - 1 || ((raw - b_s) + 1) % stride == 0
            period_reset := last_day != prev_day || last_week != prev_week || last_month != prev_month
            if !is_slot_last && !period_reset { continue }
            if slot == last_emitted_slot && !period_reset { continue }
            last_emitted_slot = slot

            x_raw := f32(f64(slot) * x_step + x_step * 0.5)
            x := f32(i32(x_raw + 0.5))

            if (render_flags & RENDER_VWAP_D) != 0 && day_acc.den > 0 {
                dv := day_acc.num / day_acc.den
                vwap_d_price = dv
                y := f32(i32(f32((max_p - dv) * inv_pr) + 0.5))
                draw_vwap_point(pos, col, &inst, limit, &day_state, x, y, line_th, day_r, day_g, day_b, day_a)

                if (render_flags & RENDER_VWAP_BANDS) != 0 {
                    var_f := day_acc.num2/day_acc.den - dv*dv
                    if var_f < 0 { var_f = 0 }
                    std := math.sqrt(var_f)
                    vwap_d_upper = dv + std
                    vwap_d_lower = dv - std
                    y_up := f32(i32(f32((max_p - vwap_d_upper) * inv_pr) + 0.5))
                    y_lo := f32(i32(f32((max_p - vwap_d_lower) * inv_pr) + 0.5))
                    draw_vwap_point(pos, col, &inst, limit, &day_up_st, x, y_up, band_th, day_r, day_g, day_b, band_a)
                    draw_vwap_point(pos, col, &inst, limit, &day_lo_st, x, y_lo, band_th, day_r, day_g, day_b, band_a)
                }
            }

            if (render_flags & RENDER_VWAP_W) != 0 && week_acc.den > 0 {
                wv := week_acc.num / week_acc.den
                vwap_w_price = wv
                y := f32(i32(f32((max_p - wv) * inv_pr) + 0.5))
                draw_vwap_point(pos, col, &inst, limit, &week_state, x, y, line_th, week_r, week_g, week_b, week_a)
            }

            if (render_flags & RENDER_VWAP_M) != 0 && month_acc.den > 0 {
                mv := month_acc.num / month_acc.den
                vwap_m_price = mv
                y := f32(i32(f32((max_p - mv) * inv_pr) + 0.5))
                draw_vwap_point(pos, col, &inst, limit, &month_state, x, y, line_th, month_r, month_g, month_b, month_a)
            }
        }

        // Project current daily VWAP to the right edge of the buffer
        // (MMT/TradingView style — flat extension into the empty future zone).
        last_slot := (buf_len - 1) / stride + 1
        x_right := f32(f64(last_slot) * x_step)
        if (render_flags & RENDER_VWAP_D) != 0 && day_state.has_prev && vwap_d_price > 0 {
            append_line_segment(pos, col, &inst, limit, day_state.prev_x, day_state.prev_y, x_right, day_state.prev_y, line_th, day_r, day_g, day_b, day_a)
        }
    }

    // ── EMA 9 / EMA 21 — one sample per aggregated slot at slot-centre X ──
    //
    // EMA itself is computed per raw candle in `recompute_ema`; here we just
    // pick the EMA value at the **last raw of each slot** (most recent close
    // in that aggregation window) and draw a line through the slot centres.
    if (render_flags & RENDER_EMA) != 0 && candle_count >= 2 && b_s < candle_count && inst < limit {
        ema9 := ema9_buf()
        ema21 := ema21_buf()
        line_th := dpr * 1.35
        if line_th < 1.5 { line_th = 1.5 }
        e9r, e9g, e9b, e9a := f32(1.0), f32(0.85), f32(0.2), f32(0.95)
        e21r, e21g, e21b, e21a := f32(0.55), f32(0.45), f32(1.0), f32(0.88)

        ema9_st := LineState{}
        ema21_st := LineState{}
        for raw := b_s; raw < b_e && raw < candle_count && inst < limit; raw += stride {
            slot_last := raw + stride - 1
            if slot_last >= b_e { slot_last = b_e - 1 }
            if slot_last >= candle_count { slot_last = candle_count - 1 }
            slot := (raw - b_s) / stride

            x_raw := f32(f64(slot) * x_step + x_step * 0.5)
            x := f32(i32(x_raw + 0.5))
            p9 := ema9[slot_last]
            p21 := ema21[slot_last]
            y9 := f32(i32(f32((max_p - p9) * inv_pr) + 0.5))
            y21 := f32(i32(f32((max_p - p21) * inv_pr) + 0.5))
            if ema9_st.has_prev {
                append_line_segment(pos, col, &inst, limit, ema9_st.prev_x, ema9_st.prev_y, x, y9, line_th, e9r, e9g, e9b, e9a)
            }
            if ema21_st.has_prev {
                append_line_segment(pos, col, &inst, limit, ema21_st.prev_x, ema21_st.prev_y, x, y21, line_th, e21r, e21g, e21b, e21a)
            }
            ema9_st.prev_x = x; ema9_st.prev_y = y9; ema9_st.has_prev = true
            ema21_st.prev_x = x; ema21_st.prev_y = y21; ema21_st.has_prev = true
        }
    }

    buf_inst_count = inst
    return inst
}
