// Heatmap-texture builder worker.
//
// Converts FlatHeatmap volume cells → packed u8 intensity strips for the GPU
// upload. Each visible column maps to one row of the streaming texture; the
// main thread copies the result via bufferSubData. Running this off-thread
// keeps frame pacing stable when the user pans across a large history.
package workers

import "../data"
import "../layers"

HeatmapTextureWorkerContext :: struct {
    sourceFlatHeatmap:        ^data.FlatHeatmap,
    renderConfig:             ^layers.HeatmapGpuRenderConfig,
    outputIntensityRgba:      [^]u8,
    columnRangeStartIndex:    i32,
    columnRangeEndIndex:      i32,
    levelsPerColumn:          i32,
}

@(export, link_name="heatmap_texture_worker_main")
heatmap_texture_worker_main :: proc "c" (context_ptr: rawptr) {
    if context_ptr == nil { return }
    worker_context := cast(^HeatmapTextureWorkerContext) context_ptr
    build_strip_range(worker_context)
}

@(private)
build_strip_range :: proc "contextless" (ctx: ^HeatmapTextureWorkerContext) {
    bytes_per_column := u32(ctx.levelsPerColumn)
    for column_index := ctx.columnRangeStartIndex;
        column_index < ctx.columnRangeEndIndex;
        column_index += 1 {
        offset := u32(column_index - ctx.columnRangeStartIndex) * bytes_per_column
        layers.heatmap_gpu_build_intensity_strip(
            ctx.renderConfig,
            ctx.sourceFlatHeatmap,
            column_index,
            ctx.outputIntensityRgba[offset:],
        )
    }
}
