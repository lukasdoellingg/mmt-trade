package orderbook

// ═══════════════════════════════════════════════════════════════
//  Orderbook depth — Odin → WASM (qty / max-qty bar width fractions)
//
//  JS packs rows as f64 pairs (price, qty) at ASK_IN / BID_IN, then
//  calls fill_*_width_fracs(n). Results: f32[0..n) in ASK_W / BID_W
//  (values in ~0..0.94 for DOM width %). No WebGL in this module.
// ═══════════════════════════════════════════════════════════════

ROW_CAP      :: 1200
F64_PER_PAIR :: 2

ASK_IN_OFF :: 0x1000
BID_IN_OFF :: 0x1000 + ROW_CAP * F64_PER_PAIR * 8
ASK_W_OFF  :: 0x8000
BID_W_OFF  :: ASK_W_OFF + ROW_CAP * 4

@(private)
f64_at :: proc "contextless" (base: uintptr, pair_i: i32, comp: i32) -> f64 {
	return (cast([^]f64)(uintptr(base)))[pair_i * F64_PER_PAIR + comp]
}

@(private)
f32_set :: proc "contextless" (base: uintptr, i: i32, v: f32) {
	(cast([^]f32)(uintptr(base)))[i] = v
}

@(private)
fill_side_width_fracs :: proc "contextless" (in_base: uintptr, out_base: uintptr, n: i32) {
	nn := n
	if nn > ROW_CAP { nn = ROW_CAP }
	if nn < 1 { return }

	mx: f64 = 1e-12
	for i: i32 = 0; i < nn; i += 1 {
		q := f64_at(in_base, i, 1)
		if q > mx { mx = q }
	}

	scale :: f64(0.94)
	for i: i32 = 0; i < nn; i += 1 {
		q := f64_at(in_base, i, 1)
		w: f32 = 0.0
		if q > 0.0 {
			w = f32((q / mx) * scale)
			if w < 0.002 { w = 0.002 }
		}
		f32_set(out_base, i, w)
	}
}

@export
fill_ask_width_fracs :: proc "contextless" (n: i32) {
	fill_side_width_fracs(uintptr(ASK_IN_OFF), uintptr(ASK_W_OFF), n)
}

@export
fill_bid_width_fracs :: proc "contextless" (n: i32) {
	fill_side_width_fracs(uintptr(BID_IN_OFF), uintptr(BID_W_OFF), n)
}

@export
get_ask_in_offset :: proc "contextless" () -> i32 { return ASK_IN_OFF }
@export
get_bid_in_offset :: proc "contextless" () -> i32 { return BID_IN_OFF }
@export
get_ask_width_frac_offset :: proc "contextless" () -> i32 { return ASK_W_OFF }
@export
get_bid_width_frac_offset :: proc "contextless" () -> i32 { return BID_W_OFF }
@export
get_row_cap :: proc "contextless" () -> i32 { return ROW_CAP }
