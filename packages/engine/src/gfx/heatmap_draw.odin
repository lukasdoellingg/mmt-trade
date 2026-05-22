// OB heatmap column preview — vertical intensity strips in the chart pane.
package gfx

import "../app"
import "../data"

HEATMAP_PREVIEW_LOW_VOLUME :: f32(0.5)
HEATMAP_PREVIEW_PEAK_VOLUME :: f32(50.0)

@(private)
heatmap_preview_intensity_byte :: proc "contextless" (volume: f32) -> u8 {
    if volume <= HEATMAP_PREVIEW_LOW_VOLUME { return 0 }
    if volume >= HEATMAP_PREVIEW_PEAK_VOLUME { return 255 }
    log_value := log_approx(f64(volume))
    log_floor := log_approx(f64(HEATMAP_PREVIEW_LOW_VOLUME))
    log_peak := log_approx(f64(HEATMAP_PREVIEW_PEAK_VOLUME))
    if log_peak <= log_floor { return 0 }
    ratio := (log_value - log_floor) / (log_peak - log_floor)
    if ratio < 0 { return 0 }
    if ratio > 1 { return 255 }
    return u8(ratio * 255.0)
}

@(private)
log_approx :: proc "contextless" (value: f64) -> f64 {
    if value <= 0 { return -1e30 }
    if value == 1 { return 0 }
    guess := value - 1.0
    for _ in 0..<6 {
        guess -= 1.0 - value * exp_neg_approx(guess)
    }
    return guess
}

@(private)
exp_neg_approx :: proc "contextless" (x: f64) -> f64 {
    term := 1.0
    sum := 1.0
    for index in 1..=6 {
        term *= -x / f64(index)
        sum += term
    }
    return sum
}

MAX_HEATMAP_PREVIEW_COLUMNS :: 96

heatmap_draw_preview :: proc "contextless" (
    heatmap: ^data.FlatHeatmap,
    chart_origin_x_px, chart_origin_y_px: f32,
    chart_width_px, chart_height_px: f32,
    canvas_width_px, canvas_height_px: f32,
) {
    if heatmap.columnCount <= 0 { return }
    if !app.is_render_flag_enabled(.OrderBookHeatmap) { return }

    visible_columns := heatmap.columnCount
    if visible_columns > MAX_HEATMAP_PREVIEW_COLUMNS {
        visible_columns = MAX_HEATMAP_PREVIEW_COLUMNS
    }

    column_stride_px := chart_width_px / f32(visible_columns)
    if column_stride_px < 1 {
        column_stride_px = 1
    }

    panels: [MAX_HEATMAP_PREVIEW_COLUMNS]ChromePanel
    panel_count: i32 = 0

    for column_index: i32 = 0; column_index < visible_columns; column_index += 1 {
        logical_index := heatmap.columnCount - visible_columns + column_index
        if logical_index < 0 {
            logical_index = 0
        }

        peak_intensity: u8 = 0
        base_offset := logical_index * data.HEATMAP_LEVELS_PER_COLUMN
        if heatmap.isRingMode {
            physical := (heatmap.nextWriteColumnIndex + logical_index) % data.HEATMAP_COLUMN_CAPACITY
            base_offset = physical * data.HEATMAP_LEVELS_PER_COLUMN
        }
        for level_index: i32 = 0; level_index < data.HEATMAP_LEVELS_PER_COLUMN; level_index += 1 {
            byte_value := heatmap_preview_intensity_byte(
                heatmap.volumeCells[base_offset + level_index],
            )
            if byte_value > peak_intensity {
                peak_intensity = byte_value
            }
        }
        if peak_intensity == 0 {
            continue
        }

        alpha := f32(peak_intensity) / 255.0
        x_px := chart_origin_x_px + f32(column_index) * column_stride_px
        width_px := column_stride_px * 0.85
        if panel_count >= MAX_HEATMAP_PREVIEW_COLUMNS {
            break
        }
        panels[panel_count] = ChromePanel{
            ndc_rect = chrome_pixel_rect_to_ndc(
                x_px, chart_origin_y_px, width_px, chart_height_px,
                canvas_width_px, canvas_height_px,
            ),
            color = {
                0.07 + alpha * 0.16,
                0.35 + alpha * 0.43,
                0.22 + alpha * 0.27,
                alpha * 0.55,
            },
        }
        panel_count += 1
    }

    if panel_count > 0 {
        append_quad_panels(panels[:panel_count])
    }
}
