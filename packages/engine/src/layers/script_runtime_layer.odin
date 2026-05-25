// MMT script runtime mounts — create_runtime plot output (horizontal price lines).
package layers

MAX_SCRIPT_MOUNTS_PER_PANE :: 8
MAX_PLOT_LINES :: 64
MAX_RUNTIME_ID_BYTES :: 32

ScriptRuntimeMount :: struct {
    localIdBytes:         [24]u8,
    localIdLength:        i32,
    runtimeIdBytes:       [MAX_RUNTIME_ID_BYTES]u8,
    runtimeIdLength:      i32,
    createToken:          i32,
    isVisible:            bool,
    isReady:              bool,
    zIndex:               i32,
}

PlotLine :: struct {
    runtimeIdBytes:       [MAX_RUNTIME_ID_BYTES]u8,
    runtimeIdLength:      i32,
    priceY0:              f64,
    priceY1:              f64,
    colorRed:             u8,
    colorGreen:           u8,
    colorBlue:            u8,
    alpha:                u8,
    lineWidth:            f32,
}

ScriptRuntimeLayer :: struct {
    mounts:               [MAX_SCRIPT_MOUNTS_PER_PANE]ScriptRuntimeMount,
    mountCount:           i32,
    plotLines:            [MAX_PLOT_LINES]PlotLine,
    plotLineCount:        i32,
}

script_runtime_layer_init :: proc "contextless" (layer: ^ScriptRuntimeLayer) {
    layer.mountCount = 0
    layer.plotLineCount = 0
    for index in 0..<MAX_SCRIPT_MOUNTS_PER_PANE {
        layer.mounts[index].localIdLength = 0
        layer.mounts[index].runtimeIdLength = 0
    }
}

script_runtime_clear_plots :: proc "contextless" (layer: ^ScriptRuntimeLayer) {
    layer.plotLineCount = 0
}

// MVP: store up to MAX_PLOT_LINES horizontal levels per frame batch.
script_runtime_set_plot_lines :: proc "contextless" (
    layer: ^ScriptRuntimeLayer,
    prices: []f64,
    runtime_id: string,
    base_red, base_green, base_blue: u8,
) {
    layer.plotLineCount = 0
    for index in 0..<len(prices) {
        if layer.plotLineCount >= MAX_PLOT_LINES { break }
        plot := &layer.plotLines[layer.plotLineCount]
        count := min(len(runtime_id), MAX_RUNTIME_ID_BYTES)
        for byte_index in 0..<count {
            plot.runtimeIdBytes[byte_index] = runtime_id[byte_index]
        }
        plot.runtimeIdLength = i32(count)
        plot.priceY0 = prices[index]
        plot.priceY1 = prices[index]
        plot.colorRed = base_red
        plot.colorGreen = base_green
        plot.colorBlue = base_blue
        plot.alpha = 217
        plot.lineWidth = 1.0
        layer.plotLineCount += 1
    }
}
