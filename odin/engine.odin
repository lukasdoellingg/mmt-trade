package engine

// ═══════════════════════════════════════════════════════════════
//  WebGL2 Chart Engine — Odin → WASM (freestanding, js_wasm32)
//
//  Architecture:
//  - 5000-candle shared buffer for deep history panning
//  - Stride-based OHLC aggregation for zoomed-out rendering
//  - Buffer-range rendering: WASM pre-computes a padded range,
//    GPU pans within it via u_camera_x uniform (zero WASM cost)
//  - Rolling VWAP D/W/M (sliding window, two-pointer O(n))
//  - Key Levels: anchored on the latest candle's UTC date,
//    looking back for D/W/M open/high/low + previous periods
//  - Volume Profile: visible-range histogram with POC/VAH/VAL
//  - ALL exported params are f64 for safe JS ↔ WASM ABI
// ═══════════════════════════════════════════════════════════════

MAX_INSTANCES :: 50_000
MAX_CANDLES   :: 5000
CANDLE_FIELDS :: 7
LIQ_CAP       :: 600
LIQ_FIELDS    :: 4

// Key Levels: 16 slots × (price f64, kind i32, _pad i32) = 16 B
KEY_LEVELS_CAP :: 16
KEY_LEVEL_REC  :: 16

// Volume profile bins
VP_BINS_MAX :: 256

// ── Memory layout ──
// Region              Offset       Size (bytes)
// POS (f32×4)         0x10000      800,000   50k instances
// COL (f32×4)         0xD3500      800,000
// LUT (u32)           0x196A00       1,024
// CANDLE (f64×7)      0x196E00     280,000   5000 candles
// EMA9 (f64)          0x1DB440      40,000
// EMA21 (f64)         0x1E5080      40,000
// LIQ (f64×4)         0x1EECC0      19,200
// VWAP_D (f64)        0x1F3800      40,000
// VWAP_W (f64)        0x1FD440      40,000
// VWAP_M (f64)        0x207080      40,000
// KEY_LEVELS          0x211000         256   16 × 16 B
// VOL_PROFILE (f32)   0x211200       1,024   256 bins
// Peak usage:         0x211600 ≈ 2,168,832 B → 34 pages
// Target: 36 pages (2,359,296 B) for headroom

POS_OFFSET    :: 0x10000
COL_OFFSET    :: 0xD3500
LUT_OFFSET    :: 0x196A00
CANDLE_OFFSET :: 0x196E00
EMA9_OFFSET   :: 0x1DB440
EMA21_OFFSET  :: 0x1E5080
LIQ_OFFSET    :: 0x1EECC0
VWAP_D_OFFSET :: 0x1F3800
VWAP_W_OFFSET :: 0x1FD440
VWAP_M_OFFSET :: 0x207080
KEY_LEVELS_OFFSET :: 0x211000
VP_OFFSET         :: 0x211200

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

key_levels_count: i32
vp_bins_count:    i32
vp_max_vol:       f64
vp_poc_price:     f64
vp_vah_price:     f64
vp_val_price:     f64
vp_price_lo:      f64
vp_price_hi:      f64

// Indicator render flags (bitset). See set_indicator_flags below.
//   bit 0  →  VWAP D segments
//   bit 1  →  VWAP W segments
//   bit 2  →  VWAP M segments
//   bit 3  →  Key-level horizontal lines
//   bit 4  →  Volume-profile bars (right-edge strip)
indicator_flags: u32 = 0
vp_strip_w:      f32 = 110.0     // logical CSS pixels (will be × dpr internally)

EMA9_K  :: 2.0 / 10.0
EMA21_K :: 2.0 / 22.0
LINE_THICK_LOGICAL :: 1.6        // CSS pixels (multiplied by dpr at emit)

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
@(private) vwap_d   :: proc "contextless" () -> [^]f64 { return cast([^]f64) uintptr(VWAP_D_OFFSET) }
@(private) vwap_w   :: proc "contextless" () -> [^]f64 { return cast([^]f64) uintptr(VWAP_W_OFFSET) }
@(private) vwap_m   :: proc "contextless" () -> [^]f64 { return cast([^]f64) uintptr(VWAP_M_OFFSET) }
@(private) key_levels_f64 :: proc "contextless" () -> [^]f64 { return cast([^]f64) uintptr(KEY_LEVELS_OFFSET) }
@(private) key_levels_i32 :: proc "contextless" () -> [^]i32 { return cast([^]i32) uintptr(KEY_LEVELS_OFFSET) }
@(private) vp_bins  :: proc "contextless" () -> [^]f32 { return cast([^]f32) uintptr(VP_OFFSET) }

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
@export get_vwap_d_offset :: proc "contextless" () -> i32 { return VWAP_D_OFFSET }
@export get_vwap_w_offset :: proc "contextless" () -> i32 { return VWAP_W_OFFSET }
@export get_vwap_m_offset :: proc "contextless" () -> i32 { return VWAP_M_OFFSET }
@export get_key_levels_offset :: proc "contextless" () -> i32 { return KEY_LEVELS_OFFSET }
@export get_vol_profile_offset :: proc "contextless" () -> i32 { return VP_OFFSET }
@export get_key_levels_cap :: proc "contextless" () -> i32 { return KEY_LEVELS_CAP }
@export get_vp_bins_max :: proc "contextless" () -> i32 { return VP_BINS_MAX }

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
@export get_key_levels_count :: proc "contextless" () -> i32 { return key_levels_count }
@export get_vp_bins_count    :: proc "contextless" () -> i32 { return vp_bins_count }
@export get_vp_max_vol       :: proc "contextless" () -> f64 { return vp_max_vol }
@export get_vp_poc           :: proc "contextless" () -> f64 { return vp_poc_price }
@export get_vp_vah           :: proc "contextless" () -> f64 { return vp_vah_price }
@export get_vp_val           :: proc "contextless" () -> f64 { return vp_val_price }
@export get_vp_lo            :: proc "contextless" () -> f64 { return vp_price_lo }
@export get_vp_hi            :: proc "contextless" () -> f64 { return vp_price_hi }

// ── Setters ──
@export set_candle_count    :: proc "contextless" (n: i32) { candle_count = clamp_i32(n, 0, MAX_CANDLES) }
@export set_liq_count       :: proc "contextless" (n: i32) { liq_count = clamp_i32(n, 0, LIQ_CAP) }
@export set_mid_price       :: proc "contextless" (p: f64) { mid_price = p }
@export set_indicator_flags :: proc "contextless" (f: u32) { indicator_flags = f }
@export set_vp_strip_w      :: proc "contextless" (w: f64) { vp_strip_w = f32(w) }

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
    key_levels_count = 0; vp_bins_count = 0
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

// ═══════════════════════════════════════════════════════════════
//  ROLLING VWAP D/W/M — Two-pointer sliding window, O(n) per series.
//  win_*_ms = lookback window in milliseconds (e.g. 24h / 7d / 30d).
//  Writes results directly into VWAP_D/W/M memory regions.
//
//  Saves final window state in module-level globals so live ticks
//  can be processed by update_vwap_last() in O(1).
// ═══════════════════════════════════════════════════════════════

// Persistent state captured at the END of the last full sweep, so live ticks
// can patch the last bar without re-iterating the whole candle buffer.
@(private) vwap_d_pv:       f64
@(private) vwap_d_v:        f64
@(private) vwap_d_j:        i32
@(private) vwap_d_last_pv:  f64   // tp*vol contribution of the last bar
@(private) vwap_d_last_vol: f64   // vol of the last bar
@(private) vwap_w_pv:       f64
@(private) vwap_w_v:        f64
@(private) vwap_w_j:        i32
@(private) vwap_w_last_pv:  f64
@(private) vwap_w_last_vol: f64
@(private) vwap_m_pv:       f64
@(private) vwap_m_v:        f64
@(private) vwap_m_j:        i32
@(private) vwap_m_last_pv:  f64
@(private) vwap_m_last_vol: f64

@export
compute_vwap_rolling :: proc "contextless" (win_d_ms, win_w_ms, win_m_ms: f64) {
    if candle_count < 1 { return }

    vd := vwap_d(); vw := vwap_w(); vm := vwap_m()

    pv_d: f64 = 0; v_d: f64 = 0; j_d: i32 = 0
    pv_w: f64 = 0; v_w: f64 = 0; j_w: i32 = 0
    pv_m: f64 = 0; v_m: f64 = 0; j_m: i32 = 0
    last_pv: f64 = 0; last_vol: f64 = 0

    for i: i32 = 0; i < candle_count; i += 1 {
        ts  := c_ts(i)
        tp  := (c_high(i) + c_low(i) + c_close(i)) / 3.0
        vol := c_vol(i)
        pv  := tp * vol

        pv_d += pv; v_d += vol
        pv_w += pv; v_w += vol
        pv_m += pv; v_m += vol

        for j_d <= i {
            if ts - c_ts(j_d) <= win_d_ms { break }
            vj := c_vol(j_d)
            pv_d -= (c_high(j_d) + c_low(j_d) + c_close(j_d)) / 3.0 * vj
            v_d  -= vj
            j_d += 1
        }
        for j_w <= i {
            if ts - c_ts(j_w) <= win_w_ms { break }
            vj := c_vol(j_w)
            pv_w -= (c_high(j_w) + c_low(j_w) + c_close(j_w)) / 3.0 * vj
            v_w  -= vj
            j_w += 1
        }
        for j_m <= i {
            if ts - c_ts(j_m) <= win_m_ms { break }
            vj := c_vol(j_m)
            pv_m -= (c_high(j_m) + c_low(j_m) + c_close(j_m)) / 3.0 * vj
            v_m  -= vj
            j_m += 1
        }

        if v_d > 0 { vd[i] = pv_d / v_d } else { vd[i] = tp }
        if v_w > 0 { vw[i] = pv_w / v_w } else { vw[i] = tp }
        if v_m > 0 { vm[i] = pv_m / v_m } else { vm[i] = tp }

        last_pv = pv; last_vol = vol
    }

    // Persist trailing-window state for incremental live-tick updates.
    vwap_d_pv = pv_d; vwap_d_v = v_d; vwap_d_j = j_d
    vwap_w_pv = pv_w; vwap_w_v = v_w; vwap_w_j = j_w
    vwap_m_pv = pv_m; vwap_m_v = v_m; vwap_m_j = j_m
    vwap_d_last_pv = last_pv; vwap_d_last_vol = last_vol
    vwap_w_last_pv = last_pv; vwap_w_last_vol = last_vol
    vwap_m_last_pv = last_pv; vwap_m_last_vol = last_vol
}

// ═══════════════════════════════════════════════════════════════
//  INCREMENTAL VWAP — O(1) refresh of the LAST bar's value only.
//  Use this on same-bar live ticks (OHLCV updated for current bar).
//  For new-bar transitions, call compute_vwap_rolling instead.
// ═══════════════════════════════════════════════════════════════
@export
update_vwap_last :: proc "contextless" (win_d_ms, win_w_ms, win_m_ms: f64) {
    if candle_count < 1 { return }
    last := candle_count - 1
    ts   := c_ts(last)
    tp   := (c_high(last) + c_low(last) + c_close(last)) / 3.0
    vol  := c_vol(last)
    pv   := tp * vol

    vwap_d_pv += pv  - vwap_d_last_pv
    vwap_d_v  += vol - vwap_d_last_vol
    vwap_w_pv += pv  - vwap_w_last_pv
    vwap_w_v  += vol - vwap_w_last_vol
    vwap_m_pv += pv  - vwap_m_last_pv
    vwap_m_v  += vol - vwap_m_last_vol

    // Window may need to advance on long-running live bars; rare but covers
    // edge cases when no full recompute has run for many minutes.
    for vwap_d_j < last {
        if ts - c_ts(vwap_d_j) <= win_d_ms { break }
        vj := c_vol(vwap_d_j)
        vwap_d_pv -= (c_high(vwap_d_j) + c_low(vwap_d_j) + c_close(vwap_d_j)) / 3.0 * vj
        vwap_d_v  -= vj
        vwap_d_j  += 1
    }
    for vwap_w_j < last {
        if ts - c_ts(vwap_w_j) <= win_w_ms { break }
        vj := c_vol(vwap_w_j)
        vwap_w_pv -= (c_high(vwap_w_j) + c_low(vwap_w_j) + c_close(vwap_w_j)) / 3.0 * vj
        vwap_w_v  -= vj
        vwap_w_j  += 1
    }
    for vwap_m_j < last {
        if ts - c_ts(vwap_m_j) <= win_m_ms { break }
        vj := c_vol(vwap_m_j)
        vwap_m_pv -= (c_high(vwap_m_j) + c_low(vwap_m_j) + c_close(vwap_m_j)) / 3.0 * vj
        vwap_m_v  -= vj
        vwap_m_j  += 1
    }

    vwap_d_last_pv = pv; vwap_d_last_vol = vol
    vwap_w_last_pv = pv; vwap_w_last_vol = vol
    vwap_m_last_pv = pv; vwap_m_last_vol = vol

    vd := vwap_d(); vw := vwap_w(); vm := vwap_m()
    if vwap_d_v > 0 { vd[last] = vwap_d_pv / vwap_d_v } else { vd[last] = tp }
    if vwap_w_v > 0 { vw[last] = vwap_w_pv / vwap_w_v } else { vw[last] = tp }
    if vwap_m_v > 0 { vm[last] = vwap_m_pv / vwap_m_v } else { vm[last] = tp }
}

// ═══════════════════════════════════════════════════════════════
//  KEY LEVELS — anchored on the latest candle (chart "now"),
//  looking back for D / Prev-D / W / Prev-W / M / Prev-M
//  open/high/low. Stored as (price: f64, kind: i32, pad: i32)
//  records. Kind codes:
//    0 D-Open, 1 D-High,  2 D-Low,
//    3 PD-High, 4 PD-Low,
//    5 W-Open, 6 W-High, 7 W-Low,
//    8 PW-High, 9 PW-Low,
//    10 M-Open, 11 PM-High, 12 PM-Low
// ═══════════════════════════════════════════════════════════════

MS_PER_DAY  :: 86_400_000.0
MS_PER_WEEK :: 604_800_000.0

// Howard Hinnant civil_from_days — returns (y, m, d) in UTC for unix day count.
@(private)
civil_from_days :: proc "contextless" (z: i64) -> (y: i32, mo: i32, d: i32) {
    zz := z + 719468
    era: i64 = zz / 146097
    if zz < 0 && (zz % 146097) != 0 { era -= 1 }
    doe := zz - era * 146097
    if doe < 0 { doe = 0 }
    doe_u := u64(doe)
    yoe := (doe_u - doe_u / 1460 + doe_u / 36524 - doe_u / 146096) / 365
    Y := i64(yoe) + era * 400
    doy := doe_u - (365 * yoe + yoe / 4 - yoe / 100 + yoe / 400)
    mp := (5 * doy + 2) / 153
    dd := i32(doy - (153 * mp + 2) / 5 + 1)
    mm: i32
    if mp < 10 { mm = i32(mp) + 3 } else { mm = i32(mp) - 9 }
    YY := i32(Y)
    if mm <= 2 { YY += 1 }
    return YY, mm, dd
}

@(private)
days_from_civil :: proc "contextless" (y, mo, d: i32) -> i64 {
    yy: i32 = y
    if mo <= 2 { yy -= 1 }
    era: i64
    if yy >= 0 { era = i64(yy) / 400 } else { era = (i64(yy) - 399) / 400 }
    yoe := u64(i64(yy) - era * 400)
    mm: u64
    if mo > 2 { mm = u64(mo - 3) } else { mm = u64(mo + 9) }
    doy := (153 * mm + 2) / 5 + u64(d) - 1
    doe := yoe * 365 + yoe / 4 - yoe / 100 + doy
    return era * 146097 + i64(doe) - 719468
}

@(private)
start_of_day_utc :: proc "contextless" (ts_ms: f64) -> f64 {
    days := i64(ts_ms / MS_PER_DAY)
    return f64(days) * MS_PER_DAY
}

@(private)
start_of_week_utc :: proc "contextless" (ts_ms: f64) -> f64 {
    // ISO Monday 00:00 UTC. Unix epoch is Thursday → +3 day shift.
    OFFSET :: 3.0 * MS_PER_DAY
    weeks := i64((ts_ms + OFFSET) / MS_PER_WEEK)
    return f64(weeks) * MS_PER_WEEK - OFFSET
}

@(private)
start_of_month_utc :: proc "contextless" (ts_ms: f64) -> f64 {
    days := i64(ts_ms / MS_PER_DAY)
    y, m, _ := civil_from_days(days)
    return f64(days_from_civil(y, m, 1)) * MS_PER_DAY
}

// Scan candles within [start_ts, end_ts) and write (open, high, low) into outs.
@(private)
scan_bucket :: proc "contextless" (start_ts, end_ts: f64) -> (lo, hi, op: f64, ok: bool) {
    lo = 1e308; hi = -1e308; op = 0
    opened := false
    for i: i32 = 0; i < candle_count; i += 1 {
        ts := c_ts(i)
        if ts < start_ts { continue }
        if ts >= end_ts { break }
        if !opened { op = c_open(i); opened = true }
        h := c_high(i); l := c_low(i)
        if h > hi { hi = h }
        if l < lo { lo = l }
    }
    return lo, hi, op, opened
}

@(private)
push_level :: proc "contextless" (price: f64, kind: i32) {
    if key_levels_count >= KEY_LEVELS_CAP { return }
    base := key_levels_count * 2          // record = 16 B = 2× f64
    key_levels_f64()[base] = price
    key_levels_i32()[base * 2 + 2] = kind // i32 at byte offset +8
    key_levels_count += 1
}

@export
compute_key_levels :: proc "contextless" () {
    key_levels_count = 0
    if candle_count < 2 { return }

    anchor := c_ts(candle_count - 1)

    d_start := start_of_day_utc(anchor)
    d_end   := d_start + MS_PER_DAY
    pd_start := d_start - MS_PER_DAY

    w_start := start_of_week_utc(anchor)
    w_end   := w_start + MS_PER_WEEK
    pw_start := w_start - MS_PER_WEEK

    m_start := start_of_month_utc(anchor)
    pm_start := start_of_month_utc(m_start - 1.0)

    // Current day
    lo, hi, op, ok := scan_bucket(d_start, d_end)
    if ok {
        if op > 0 { push_level(op, 0) }
        if hi > 0 { push_level(hi, 1) }
        if lo < 1e308 && lo > 0 { push_level(lo, 2) }
    }
    // Previous day
    lo, hi, op, ok = scan_bucket(pd_start, d_start)
    if ok {
        if hi > 0 { push_level(hi, 3) }
        if lo < 1e308 && lo > 0 { push_level(lo, 4) }
    }
    // Current week
    lo, hi, op, ok = scan_bucket(w_start, w_end)
    if ok {
        if op > 0 { push_level(op, 5) }
        if hi > 0 { push_level(hi, 6) }
        if lo < 1e308 && lo > 0 { push_level(lo, 7) }
    }
    // Previous week
    lo, hi, op, ok = scan_bucket(pw_start, w_start)
    if ok {
        if hi > 0 { push_level(hi, 8) }
        if lo < 1e308 && lo > 0 { push_level(lo, 9) }
    }
    // Current month (open only — H/L would shift constantly)
    _, _, op, ok = scan_bucket(m_start, m_start + 32.0 * MS_PER_DAY)
    if ok && op > 0 { push_level(op, 10) }
    // Previous month
    lo, hi, _, ok = scan_bucket(pm_start, m_start)
    if ok {
        if hi > 0 { push_level(hi, 11) }
        if lo < 1e308 && lo > 0 { push_level(lo, 12) }
    }
}

// ═══════════════════════════════════════════════════════════════
//  VOLUME PROFILE — Visible-range histogram with POC/VAH/VAL.
//  Bins typical-price-weighted volume into n_bins between
//  [price_lo, price_hi]. Value area = 70% of total volume around POC.
// ═══════════════════════════════════════════════════════════════

VALUE_AREA_PCT :: 0.7

@export
compute_vol_profile :: proc "contextless" (vis_s_f, vis_e_f: f64, price_lo, price_hi: f64, n_bins_f: f64) {
    vp_bins_count = 0
    vp_max_vol = 0
    vp_poc_price = 0; vp_vah_price = 0; vp_val_price = 0
    vp_price_lo = price_lo; vp_price_hi = price_hi

    if candle_count < 1 || price_hi <= price_lo { return }

    n_bins := clamp_i32(i32(n_bins_f), 4, VP_BINS_MAX)
    s := clamp_i32(i32(vis_s_f), 0, candle_count - 1)
    e := clamp_i32(i32(vis_e_f), s + 1, candle_count)

    bins := vp_bins()
    for i: i32 = 0; i < n_bins; i += 1 { bins[i] = 0 }

    span := price_hi - price_lo
    scale := f64(n_bins) / span

    total: f64 = 0
    max_v: f32 = 0
    poc: i32 = 0
    for i := s; i < e; i += 1 {
        tp := (c_high(i) + c_low(i) + c_close(i)) / 3.0
        v := c_vol(i)
        if v <= 0 { continue }
        bi_f := (tp - price_lo) * scale
        bi := i32(bi_f)
        if bi < 0 { bi = 0 }; if bi >= n_bins { bi = n_bins - 1 }
        bins[bi] += f32(v)
        total += v
        if bins[bi] > max_v { max_v = bins[bi]; poc = bi }
    }

    vp_bins_count = n_bins
    vp_max_vol = f64(max_v)
    if total <= 0 { return }

    target := total * VALUE_AREA_PCT
    cum := f64(bins[poc])
    lo_b := poc
    hi_b := poc
    for cum < target {
        up_v: f64 = -1
        dn_v: f64 = -1
        if hi_b + 1 < n_bins { up_v = f64(bins[hi_b + 1]) }
        if lo_b - 1 >= 0     { dn_v = f64(bins[lo_b - 1]) }
        if up_v < 0 && dn_v < 0 { break }
        if up_v >= dn_v {
            if hi_b + 1 < n_bins { hi_b += 1; cum += f64(bins[hi_b]) }
            else if lo_b - 1 >= 0 { lo_b -= 1; cum += f64(bins[lo_b]) }
        } else {
            if lo_b - 1 >= 0 { lo_b -= 1; cum += f64(bins[lo_b]) }
            else if hi_b + 1 < n_bins { hi_b += 1; cum += f64(bins[hi_b]) }
        }
    }
    bin_w := span / f64(n_bins)
    vp_poc_price = price_lo + (f64(poc) + 0.5) * bin_w
    vp_vah_price = price_lo + f64(hi_b + 1) * bin_w
    vp_val_price = price_lo + f64(lo_b) * bin_w
}

// ═══════════════════════════════════════════════════════════════
//  Indicator emit helpers — VWAP / Key Levels / Vol Profile
//  Write quads directly into the WebGL POS/COL instance buffers.
//  Negative width  →  screen-space (no camera_x shift in shader)
// ═══════════════════════════════════════════════════════════════

@(private)
emit_quad :: proc "contextless" (
    pos: [^]f32, col: [^]f32,
    inst: i32, x, y, w, h, r, g, b, a: f32,
) {
    off := inst * 4
    pos[off] = x; pos[off+1] = y; pos[off+2] = w; pos[off+3] = h
    col[off] = r; col[off+1] = g; col[off+2] = b; col[off+3] = a
}

@(private)
kl_color :: proc "contextless" (kind: i32) -> (r, g, b: f32) {
    switch kind {
    case  0: return 0.91, 0.91, 0.94   // D-Open
    case  1: return 0.94, 0.75, 0.25   // D-High
    case  2: return 0.94, 0.75, 0.25   // D-Low
    case  3: return 0.88, 0.38, 0.94   // PD-High
    case  4: return 0.35, 0.85, 0.66   // PD-Low
    case  5: return 1.00, 1.00, 1.00   // W-Open
    case  6: return 0.94, 0.75, 0.25   // W-High
    case  7: return 0.94, 0.75, 0.25   // W-Low
    case  8: return 0.88, 0.38, 0.94   // PW-High
    case  9: return 0.35, 0.85, 0.66   // PW-Low
    case 10: return 0.63, 0.66, 0.78   // M-Open
    case 11: return 0.94, 0.31, 0.38   // PM-High
    case 12: return 0.35, 0.63, 0.91   // PM-Low
    case:    return 0.50, 0.50, 0.50
    }
}

// Emits one VWAP series as bar-aligned thick horizontal segments +
// vertical "step" connectors. Camera-space (positive width).
@(private)
emit_vwap_series :: proc "contextless" (
    pos: [^]f32, col: [^]f32,
    inst, limit: i32,
    b_s, b_e, stride: i32,
    x_step, max_p, inv_pr: f64,
    line_h, ph: f32,
    vwap_arr: [^]f64,
    r, g, b: f32,
) -> i32 {
    cur := inst
    half_h := line_h * 0.5
    prev_y: f32 = 0
    prev_x_right: f32 = 0
    prev_valid := false
    for raw := b_s; raw < b_e && raw < candle_count && cur < limit; raw += stride {
        slot_end := raw + stride - 1
        if slot_end >= candle_count { slot_end = candle_count - 1 }
        val := vwap_arr[slot_end]
        if val <= 0 { prev_valid = false; continue }
        agg_i := (raw - b_s) / stride
        x_left := f32(f64(agg_i) * x_step)
        x_right := x_left + f32(x_step)
        y := f32((max_p - val) * inv_pr)
        if y >= -line_h && y <= ph + line_h {
            emit_quad(pos, col, cur, x_left, y - half_h, f32(x_step), line_h, r, g, b, 0.95)
            cur += 1
        }
        if prev_valid && cur < limit {
            dy := y - prev_y
            ady := dy
            if ady < 0 { ady = -ady }
            if ady > line_h {
                y_top: f32 = prev_y
                if dy > 0 { y_top = prev_y } else { y_top = y }
                emit_quad(
                    pos, col, cur,
                    prev_x_right - half_h, y_top - half_h,
                    line_h, ady + line_h,
                    r, g, b, 0.95,
                )
                cur += 1
            }
        }
        prev_y = y
        prev_x_right = x_right
        prev_valid = true
    }
    return cur
}

@(private)
emit_key_levels :: proc "contextless" (
    pos: [^]f32, col: [^]f32,
    inst, limit: i32,
    pw, ph: f32, max_p, inv_pr: f64, dpr: f32,
) -> i32 {
    cur := inst
    klf := key_levels_f64()
    kli := key_levels_i32()
    line_h := dpr * 1.0
    for i: i32 = 0; i < key_levels_count && cur < limit; i += 1 {
        price := klf[i * 2]
        kind  := kli[i * 4 + 2]
        if kind < 0 || kind >= 13 { continue }
        y := f32((max_p - price) * inv_pr)
        if y < 0 || y > ph { continue }
        r, g, b := kl_color(kind)
        // Negative width → screen-space, spans whole plot
        emit_quad(pos, col, cur, 0, y - line_h * 0.5, -pw, line_h, r, g, b, 0.82)
        cur += 1
    }
    return cur
}

@(private)
emit_vol_profile_bars :: proc "contextless" (
    pos: [^]f32, col: [^]f32,
    inst, limit: i32,
    pw, ph: f32, max_p, inv_pr: f64, dpr: f32,
) -> i32 {
    cur := inst
    if vp_bins_count <= 0 || vp_max_vol <= 0 { return cur }
    bins := vp_bins()
    strip := vp_strip_w * dpr
    y_a := f32((max_p - vp_price_lo) * inv_pr)
    y_b := f32((max_p - vp_price_hi) * inv_pr)
    strip_top: f32; strip_bot: f32
    if y_b < y_a { strip_top = y_b; strip_bot = y_a } else { strip_top = y_a; strip_bot = y_b }
    if strip_bot <= strip_top + 1 { return cur }
    strip_ph := strip_bot - strip_top
    y_step := strip_ph / f32(vp_bins_count)
    if y_step < 1 { y_step = 1 }
    x_strip_left := pw - strip
    inner_w := strip - 4 * dpr
    if inner_w < 4 { inner_w = 4 }
    max_v_f := f32(vp_max_vol)
    bar_h := y_step - 1
    if bar_h < 1 { bar_h = 1 }
    for bi: i32 = 0; bi < vp_bins_count && cur < limit; bi += 1 {
        v := bins[bi]
        if !(v > 0) { continue }
        w_bar := (v / max_v_f) * inner_w
        if w_bar < 0.5 { continue }
        y_top := strip_bot - (f32(bi) + 1) * y_step
        if y_top < -y_step || y_top > ph { continue }
        x_left := x_strip_left + strip - w_bar - 2 * dpr
        // Negative width → screen-space
        emit_quad(pos, col, cur, x_left, y_top, -w_bar, bar_h, 0.43, 0.63, 1.0, 0.62)
        cur += 1
    }
    return cur
}

// ── Stride-aware OHLC aggregation ──
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
    // v_e_raw may exceed candle_count when the user pans past the live edge.
    // We keep v_e clamped to candle_count for Y-axis fit + candle iteration,
    // but use v_e_raw for x-step / vis_agg so empty space appears on the right.
    v_e_raw := i32(vis_end_f)
    if v_e_raw < v_s + 1 { v_e_raw = v_s + 1 }
    v_e := clamp_i32(v_e_raw, 1, candle_count)

    b_s = (b_s / stride) * stride
    if b_e <= b_s { return 0 }
    if v_e <= v_s { return 0 }

    vis_len := v_e_raw - v_s
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

    x_step := f64(pw) / f64(vis_agg)

    cw_f := x_step * 0.6
    if cw_f < 1 { cw_f = 1 }
    max_cw := f64(14 * dpr)
    if cw_f > max_cw { cw_f = max_cw }
    cw := f32(cw_f); half_cw := cw * 0.5

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
        x      := f32(i32(x_raw + 0.5))
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

    // ── Indicator passes (GPU-rendered as instanced quads) ──
    line_h := f32(LINE_THICK_LOGICAL) * dpr
    if (indicator_flags & 0x1) != 0 {
        inst = emit_vwap_series(pos, col, inst, limit, b_s, b_e, stride, x_step, max_p, inv_pr, line_h, ph, vwap_d(), 0.94, 0.75, 0.25)
    }
    if (indicator_flags & 0x2) != 0 {
        inst = emit_vwap_series(pos, col, inst, limit, b_s, b_e, stride, x_step, max_p, inv_pr, line_h, ph, vwap_w(), 0.25, 0.63, 0.94)
    }
    if (indicator_flags & 0x4) != 0 {
        inst = emit_vwap_series(pos, col, inst, limit, b_s, b_e, stride, x_step, max_p, inv_pr, line_h, ph, vwap_m(), 0.88, 0.38, 0.94)
    }
    if (indicator_flags & 0x8) != 0 && key_levels_count > 0 {
        inst = emit_key_levels(pos, col, inst, limit, pw, ph, max_p, inv_pr, dpr)
    }
    if (indicator_flags & 0x10) != 0 {
        inst = emit_vol_profile_bars(pos, col, inst, limit, pw, ph, max_p, inv_pr, dpr)
    }

    buf_inst_count = inst
    return inst
}
