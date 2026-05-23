// Flat order-book heatmap storage.
//
// MMT.gg captures show ~160 000 price levels per column × 768 visible columns.
// A naïve Map<price, volume> per column won't fit; instead we pre-allocate a
// single contiguous Float32Array of (columns × levels_per_column) cells and
// address it with linear math.
//
// Layout:
//   cell[column_index * HEATMAP_LEVELS_PER_COLUMN + level_index] = volume_in_base_units
//
// Empty cells are stored as 0.0 — a single SIMD-friendly clear suffices.
//
// Phase C bumps the budget toward MMT-grade depth:
//   - 1024 columns  × 16 384 HD levels × 4 B = 64 MiB static (fits 128 MiB initial WASM linear memory).
//   - HD/SD render mode controls the *active* slice that gets downsampled
//     onto the GPU heatmap texture — the underlying store stays HD so we
//     never lose precision in the data path.
package data

// Column capacity matches MMT capture cadence at ~1 column / 30 s × 8.5 h.
HEATMAP_COLUMN_CAPACITY :: 1024

// HD depth meets the Phase C ≥ 10 k acceptance gate. SD downsamples the same
// underlying store for the low-bin-mode toolbar toggle without reallocating.
HEATMAP_LEVELS_PER_COLUMN_HD :: 16384
HEATMAP_LEVELS_PER_COLUMN_SD :: 4096

// `HEATMAP_LEVELS_PER_COLUMN` is the slot count for the backing store; the
// renderer always sees the HD depth. SD-mode reduces only the texture upload
// resolution, not the data fidelity.
HEATMAP_LEVELS_PER_COLUMN :: HEATMAP_LEVELS_PER_COLUMN_HD

HeatmapRenderMode :: enum u8 {
    HD = 0,
    SD = 1,
}

FlatHeatmap :: struct {
    volumeCells:           [^]f32,
    bucketPriceMin:        f64,
    bucketPriceStep:       f64,             // price per row
    timestampPerColumnMs:  [^]i64,
    columnCount:           i32,
    nextWriteColumnIndex:  i32,
    isRingMode:            bool,
    renderMode:            HeatmapRenderMode,
}

flat_heatmap_init :: proc "contextless" (
    heatmap: ^FlatHeatmap,
    volume_storage: [^]f32,
    timestamp_storage: [^]i64,
    bucket_price_min: f64,
    bucket_price_step: f64,
) {
    heatmap.volumeCells = volume_storage
    heatmap.timestampPerColumnMs = timestamp_storage
    heatmap.bucketPriceMin = bucket_price_min
    heatmap.bucketPriceStep = bucket_price_step
    heatmap.columnCount = 0
    heatmap.nextWriteColumnIndex = 0
    heatmap.isRingMode = false
    heatmap.renderMode = .HD
}

flat_heatmap_set_render_mode :: proc "contextless" (
    heatmap: ^FlatHeatmap, mode: HeatmapRenderMode,
) {
    heatmap.renderMode = mode
}

flat_heatmap_active_levels_per_column :: #force_inline proc "contextless" (
    heatmap: ^FlatHeatmap,
) -> i32 {
    if heatmap.renderMode == .SD {
        return HEATMAP_LEVELS_PER_COLUMN_SD
    }
    return HEATMAP_LEVELS_PER_COLUMN_HD
}

@(private)
column_base_offset :: #force_inline proc "contextless" (
    heatmap: ^FlatHeatmap, logical_column_index: i32,
) -> i32 {
    physical := logical_column_index
    if heatmap.isRingMode {
        physical = (heatmap.nextWriteColumnIndex + logical_column_index) % HEATMAP_COLUMN_CAPACITY
    }
    return physical * HEATMAP_LEVELS_PER_COLUMN
}

// Returns the physical base offset for a column whose index was already
// resolved to a write-slot (used by the WS dispatcher and the texture-upload
// pass, where the column is identified by its write position rather than its
// logical age inside the visible window).
flat_heatmap_physical_column_offset :: #force_inline proc "contextless" (
    heatmap: ^FlatHeatmap, physical_column_index: i32,
) -> i32 {
    return physical_column_index * HEATMAP_LEVELS_PER_COLUMN
}

flat_heatmap_clear_column :: proc "contextless" (heatmap: ^FlatHeatmap, logical_column_index: i32) {
    if heatmap.volumeCells == nil { return }
    base := column_base_offset(heatmap, logical_column_index)
    for level_index: i32 = 0; level_index < HEATMAP_LEVELS_PER_COLUMN; level_index += 1 {
        heatmap.volumeCells[base + level_index] = 0
    }
}

flat_heatmap_write_level :: #force_inline proc "contextless" (
    heatmap: ^FlatHeatmap,
    logical_column_index: i32,
    price: f64,
    volume_base_units: f32,
) {
    level_index_f := (price - heatmap.bucketPriceMin) / heatmap.bucketPriceStep
    if level_index_f < 0 || level_index_f >= f64(HEATMAP_LEVELS_PER_COLUMN) { return }
    level_index := i32(level_index_f + 0.5)
    if heatmap.volumeCells == nil { return }
    base := column_base_offset(heatmap, logical_column_index)
    heatmap.volumeCells[base + level_index] = volume_base_units
}

flat_heatmap_advance_column :: proc "contextless" (
    heatmap: ^FlatHeatmap, column_timestamp_ms: i64,
) {
    if heatmap.columnCount < HEATMAP_COLUMN_CAPACITY {
        heatmap.timestampPerColumnMs[heatmap.columnCount] = column_timestamp_ms
        heatmap.columnCount += 1
    } else {
        heatmap.isRingMode = true
        heatmap.timestampPerColumnMs[heatmap.nextWriteColumnIndex] = column_timestamp_ms
        heatmap.nextWriteColumnIndex = (heatmap.nextWriteColumnIndex + 1) % HEATMAP_COLUMN_CAPACITY
    }
}

// Resolve `logical_column_index` (0..columnCount-1, 0 = oldest visible) to
// the absolute physical column slot in the ring buffer. Renderers use this
// to walk the buffer in chronological order.
flat_heatmap_physical_index :: #force_inline proc "contextless" (
    heatmap: ^FlatHeatmap, logical_column_index: i32,
) -> i32 {
    if heatmap.isRingMode {
        return (heatmap.nextWriteColumnIndex + logical_column_index) % HEATMAP_COLUMN_CAPACITY
    }
    return logical_column_index
}

// Downsample one HD column into `output_bins` (must point at >= output_bin_count
// f32 slots). Used by the GPU upload path: 16 384 HD levels collapse onto the
// 256-row R32F texture, taking the peak volume per bin to preserve highlights.
flat_heatmap_downsample_column :: proc "contextless" (
    heatmap: ^FlatHeatmap,
    physical_column_index: i32,
    output_bins: [^]f32,
    output_bin_count: i32,
) {
    if heatmap.volumeCells == nil { return }
    if output_bins == nil { return }
    if output_bin_count <= 0 { return }

    base := flat_heatmap_physical_column_offset(heatmap, physical_column_index)
    active_levels: i32 = i32(HEATMAP_LEVELS_PER_COLUMN_HD)
    if heatmap.renderMode == .SD {
        active_levels = i32(HEATMAP_LEVELS_PER_COLUMN_SD)
    }

    if output_bin_count >= active_levels {
        for bin_index: i32 = 0; bin_index < output_bin_count; bin_index += 1 {
            if bin_index < active_levels {
                output_bins[bin_index] = heatmap.volumeCells[base + bin_index]
            } else {
                output_bins[bin_index] = 0
            }
        }
        return
    }

    levels_per_bin: i32 = active_levels / output_bin_count
    if levels_per_bin <= 0 { levels_per_bin = 1 }
    for bin_index: i32 = 0; bin_index < output_bin_count; bin_index += 1 {
        start: i32 = bin_index * levels_per_bin
        end:   i32 = start + levels_per_bin
        if end > active_levels { end = active_levels }
        peak: f32 = 0
        for level_index: i32 = start; level_index < end; level_index += 1 {
            volume := heatmap.volumeCells[base + level_index]
            if volume > peak { peak = volume }
        }
        output_bins[bin_index] = peak
    }
}
