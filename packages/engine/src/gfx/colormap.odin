// GPU colormap palettes for the heatmap and indicator overlays.
//
// MMT.gg ships 25+ colormaps in `terminal.wasm`. We provide a small set as a
// reference here and a lookup function that returns RGBA8 by index. Phase 5
// expands the catalog with the full MMT set (turbo, viridis, magma, inferno,
// thermal, mmt_default, splat, etc.).
package gfx

ColormapId :: enum u8 {
    MmtDefault   = 0,
    Turbo        = 1,
    Viridis      = 2,
    Magma        = 3,
    Inferno      = 4,
    GrayscaleHot = 5,
}

COLORMAP_LUT_SIZE :: 256

ColormapEntry :: distinct u32  // packed 0xAABBGGRR

ColormapLookupTable :: struct {
    palettes:        [6][COLORMAP_LUT_SIZE]ColormapEntry,
    selectedPalette: ColormapId,
}

@(private="file") global_colormap_lut: ColormapLookupTable

colormap_table :: proc "contextless" () -> ^ColormapLookupTable {
    return &global_colormap_lut
}

initialize_default_colormaps :: proc "contextless" () {
    fill_mmt_default(&global_colormap_lut.palettes[ColormapId.MmtDefault])
    fill_turbo(&global_colormap_lut.palettes[ColormapId.Turbo])
    fill_viridis(&global_colormap_lut.palettes[ColormapId.Viridis])
    fill_magma(&global_colormap_lut.palettes[ColormapId.Magma])
    fill_inferno(&global_colormap_lut.palettes[ColormapId.Inferno])
    fill_grayscale_hot(&global_colormap_lut.palettes[ColormapId.GrayscaleHot])
    global_colormap_lut.selectedPalette = ColormapId.MmtDefault
}

colormap_sample :: #force_inline proc "contextless" (
    palette: ColormapId, intensity_byte: u8,
) -> ColormapEntry {
    return global_colormap_lut.palettes[palette][intensity_byte]
}

set_active_colormap :: proc "contextless" (palette: ColormapId) {
    global_colormap_lut.selectedPalette = palette
}

active_colormap :: #force_inline proc "contextless" () -> ColormapId {
    return global_colormap_lut.selectedPalette
}

// ── Palette generators (tuned to roughly match MMT.gg colour temperatures) ──

@(private="file")
pack_rgba8 :: #force_inline proc "contextless" (r, g, b, a: u8) -> ColormapEntry {
    return ColormapEntry(u32(r) | (u32(g) << 8) | (u32(b) << 16) | (u32(a) << 24))
}

@(private="file")
fill_mmt_default :: proc "contextless" (palette: ^[COLORMAP_LUT_SIZE]ColormapEntry) {
    for index in 0..<COLORMAP_LUT_SIZE {
        normalized := f64(index) / 255.0
        r, g, b: f64
        switch {
        case normalized < 0.25:
            s := normalized * 4.0
            r = 6 + 8 * s; g = 10 + 40 * s; b = 30 + 100 * s
        case normalized < 0.5:
            s := (normalized - 0.25) * 4.0
            r = 14 + 30 * s; g = 50 + 80 * s; b = 130 + 40 * s
        case normalized < 0.75:
            s := (normalized - 0.5) * 4.0
            r = 44 + 180 * s; g = 130 + 80 * s; b = 170 - 120 * s
        case:
            s := (normalized - 0.75) * 4.0
            r = 224 + 31 * s; g = 210 + 45 * s; b = 50 + 205 * s
        }
        alpha := u32(180 + (75 * u32(index) / 255))
        palette[index] = pack_rgba8(u8(r), u8(g), u8(b), u8(alpha))
    }
    palette[0] = ColormapEntry(0) // transparent floor
    palette[1] = ColormapEntry(0)
}

@(private="file")
fill_turbo :: proc "contextless" (palette: ^[COLORMAP_LUT_SIZE]ColormapEntry) {
    // Compact polynomial approximation of the Turbo colormap (Mikhailov 2019).
    for index in 0..<COLORMAP_LUT_SIZE {
        t := f64(index) / 255.0
        r := 34.61 + t*(1172.33 + t*(-10793.56 + t*(33300.12 + t*(-38394.49 + t*14825.05))))
        g := 23.31 + t*(557.33 + t*(1225.33 + t*(-3574.96 + t*(1073.77 + t*707.56))))
        b := 27.2 + t*(3211.1 + t*(-15327.97 + t*(27814 + t*(-22569.18 + t*6838.66))))
        palette[index] = pack_rgba8(clip_to_u8(r), clip_to_u8(g), clip_to_u8(b), u8(255))
    }
    palette[0] = ColormapEntry(0)
}

@(private="file")
fill_viridis :: proc "contextless" (palette: ^[COLORMAP_LUT_SIZE]ColormapEntry) {
    // Crude piecewise approximation; replace with real LUT in Phase 5.
    for index in 0..<COLORMAP_LUT_SIZE {
        t := f64(index) / 255.0
        r := 68 + 188 * t
        g := 1 + 230 * t
        b := 84 + 130 * (1.0 - t)
        palette[index] = pack_rgba8(clip_to_u8(r), clip_to_u8(g), clip_to_u8(b), u8(255))
    }
    palette[0] = ColormapEntry(0)
}

@(private="file")
fill_magma :: proc "contextless" (palette: ^[COLORMAP_LUT_SIZE]ColormapEntry) {
    for index in 0..<COLORMAP_LUT_SIZE {
        t := f64(index) / 255.0
        r := 252 * t
        g := 80 * t
        b := 130 * (1.0 - 0.7 * t)
        palette[index] = pack_rgba8(clip_to_u8(r), clip_to_u8(g), clip_to_u8(b), u8(255))
    }
    palette[0] = ColormapEntry(0)
}

@(private="file")
fill_inferno :: proc "contextless" (palette: ^[COLORMAP_LUT_SIZE]ColormapEntry) {
    for index in 0..<COLORMAP_LUT_SIZE {
        t := f64(index) / 255.0
        r := 255 * t
        g := 110 * t * t
        b := 35 * (1.0 - t)
        palette[index] = pack_rgba8(clip_to_u8(r), clip_to_u8(g), clip_to_u8(b), u8(255))
    }
    palette[0] = ColormapEntry(0)
}

@(private="file")
fill_grayscale_hot :: proc "contextless" (palette: ^[COLORMAP_LUT_SIZE]ColormapEntry) {
    for index in 0..<COLORMAP_LUT_SIZE {
        v := u8(index)
        palette[index] = pack_rgba8(v, v, v, v)
    }
}

@(private="file")
clip_to_u8 :: #force_inline proc "contextless" (value: f64) -> u8 {
    if value < 0   { return 0 }
    if value > 255 { return 255 }
    return u8(value)
}
