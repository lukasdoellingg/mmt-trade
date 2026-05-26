// Texture builder worker — FlatHeatmap → intensity strip (no layers dependency).
package workers

import "../data"

@(private="file")
texture_worker_ctx: HeatmapTextureWorkerContext

heatmap_texture_worker_set_context :: proc "contextless" (ctx: ^HeatmapTextureWorkerContext) {
    texture_worker_ctx = ctx^
}

@(export, link_name="heatmap_texture_worker_main")
heatmap_texture_worker_main :: proc "c" () {
    build_strip_range(&texture_worker_ctx)
}

HeatmapTextureWorkerContext :: struct {
    sourceFlatHeatmap:        ^data.FlatHeatmap,
    outputIntensityRgba:      [^]u8,
    columnRangeStartIndex:    i32,
    columnRangeEndIndex:      i32,
    levelsPerColumn:          i32,
}

@(private)
build_strip_range :: proc "contextless" (ctx: ^HeatmapTextureWorkerContext) {
    if ctx.sourceFlatHeatmap == nil { return }
    if ctx.outputIntensityRgba == nil { return }
    bytes_per_column := u32(ctx.levelsPerColumn)
    for column_index := ctx.columnRangeStartIndex;
        column_index < ctx.columnRangeEndIndex;
        column_index += 1 {
        offset := u32(column_index - ctx.columnRangeStartIndex) * bytes_per_column
        data.flat_heatmap_downsample_column(
            ctx.sourceFlatHeatmap,
            column_index,
            cast([^]f32)ctx.outputIntensityRgba[offset:],
            i32(bytes_per_column),
        )
    }
}
