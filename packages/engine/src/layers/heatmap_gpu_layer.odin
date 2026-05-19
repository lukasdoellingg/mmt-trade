// Order-book depth heatmap renderer.
//
// Reads from data.FlatHeatmap and uploads one R32F texture per column slice
// to Sokol. The shader samples the colormap LUT (see gfx/colormap.odin) and
// applies a Gaussian-splat falloff for visual continuity between adjacent
// levels. MMT.gg's HD mode handles ~160k levels — Phase 8 will tune the
// memory budget against device-pixel-ratio.
package layers

import "../data"
import "../gfx"

HEATMAP_GPU_PEAK_VOLUME_THRESHOLD :: 50.0
HEATMAP_GPU_LOW_VOLUME_THRESHOLD  :: 0.5

HeatmapGpuRenderConfig :: struct {
    activeColormap:           gfx.ColormapId,
    lowVolumeFloor:           f32,
    peakVolumeCap:            f32,
    gaussianSplatRadiusCells: f32,
    enableLogScale:           bool,
}

heatmap_gpu_default_config :: proc "contextless" () -> HeatmapGpuRenderConfig {
    return HeatmapGpuRenderConfig{
        activeColormap           = .MmtDefault,
        lowVolumeFloor           = f32(HEATMAP_GPU_LOW_VOLUME_THRESHOLD),
        peakVolumeCap            = f32(HEATMAP_GPU_PEAK_VOLUME_THRESHOLD),
        gaussianSplatRadiusCells = 1.5,
        enableLogScale           = true,
    }
}

// Normalize a volume into [0,255] using log scaling (or linear if disabled).
heatmap_gpu_intensity_byte :: #force_inline proc "contextless" (
    config: ^HeatmapGpuRenderConfig, volume_base_units: f32,
) -> u8 {
    if volume_base_units <= config.lowVolumeFloor { return 0 }
    if volume_base_units >= config.peakVolumeCap { return 255 }
    if !config.enableLogScale {
        ratio := (volume_base_units - config.lowVolumeFloor) / (config.peakVolumeCap - config.lowVolumeFloor)
        return u8(ratio * 255.0)
    }
    log_value      := natural_log(f64(volume_base_units))
    log_floor      := natural_log(f64(config.lowVolumeFloor))
    log_peak       := natural_log(f64(config.peakVolumeCap))
    if log_peak <= log_floor { return 0 }
    ratio := (log_value - log_floor) / (log_peak - log_floor)
    if ratio < 0 { return 0 }
    if ratio > 1 { return 255 }
    return u8(ratio * 255.0)
}

// Phase 5 will fill in the Sokol texture upload + draw. The function below
// reserves the public contract: emit a per-column intensity ramp for the
// instanced quad shader.
heatmap_gpu_build_intensity_strip :: proc "contextless" (
    config: ^HeatmapGpuRenderConfig,
    heatmap: ^data.FlatHeatmap,
    column_index: i32,
    output_intensity_bytes: [^]u8,
) {
    if column_index < 0 || column_index >= heatmap.columnCount { return }
    base_offset := column_index * data.HEATMAP_LEVELS_PER_COLUMN
    for level_index: i32 = 0; level_index < data.HEATMAP_LEVELS_PER_COLUMN; level_index += 1 {
        volume := heatmap.volumeCells[base_offset + level_index]
        output_intensity_bytes[level_index] = heatmap_gpu_intensity_byte(config, volume)
    }
}

@(private)
natural_log :: #force_inline proc "contextless" (value: f64) -> f64 {
    // Phase 8 swaps this stub for an inlined approximation tuned for the
    // intensity normalisation range. The math/std library version is fine
    // for now; once we link libm via emcc the @(link_name) extern can call
    // into ldexp/frexp directly.
    if value <= 0 { return -1e30 }
    if value == 1 { return 0 }
    // Newton-Raphson exp inverse — 8 iterations are enough at this range.
    guess := value - 1.0
    for _ in 0..<8 { guess -= 1.0 - value * negative_exp(guess) }
    return guess
}

@(private)
negative_exp :: #force_inline proc "contextless" (x: f64) -> f64 {
    // Taylor approximation around 0; fine for our ratio-of-logs use.
    term := 1.0
    sum  := 1.0
    for index in 1..=8 {
        term *= -x / f64(index)
        sum += term
    }
    return sum
}
