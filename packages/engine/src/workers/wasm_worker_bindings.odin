// Emscripten WASM Worker bindings.
//
// Distinct from Web Workers: emscripten_create_wasm_worker spawns a new POSIX
// thread sharing the same wasm.memory (via SharedArrayBuffer). The worker
// runs an exported function and posts back via shared atomics. This file
// vendors just the three calls we use.
//
// Requires: -sSHARED_MEMORY=1 -sWASM_WORKERS=1 -pthread link flags.
package workers

WasmWorkerHandle :: distinct i32

@(default_calling_convention="c")
foreign emscripten_wasm_workers {
    @(link_name="emscripten_create_wasm_worker_with_initial_size")
    create_worker_with_initial_size :: proc(
        worker_stack_size_bytes: i32,
    ) -> i32 ---

    @(link_name="emscripten_wasm_worker_post_function_v")
    post_function_void :: proc(
        worker: i32, exported_function_ptr: rawptr,
    ) ---

    @(link_name="emscripten_terminate_wasm_worker")
    terminate_worker :: proc(worker: i32) ---
}

WasmWorkerKind :: enum u8 {
    WebSocketDecoder = 0,
    IndicatorCompute = 1,
    HeatmapTextureBuilder = 2,
}

WasmWorkerHandles :: struct {
    websocketDecoderHandle:        WasmWorkerHandle,
    indicatorComputeHandle:        WasmWorkerHandle,
    heatmapTextureBuilderHandle:   WasmWorkerHandle,
    workerStackBytes:              i32,
}

DEFAULT_WORKER_STACK_BYTES :: 1024 * 1024  // 1 MiB

wasm_workers_spawn_all :: proc "contextless" (handles: ^WasmWorkerHandles) {
    if handles.workerStackBytes <= 0 {
        handles.workerStackBytes = DEFAULT_WORKER_STACK_BYTES
    }
    handles.websocketDecoderHandle      = WasmWorkerHandle(create_worker_with_initial_size(handles.workerStackBytes))
    handles.indicatorComputeHandle      = WasmWorkerHandle(create_worker_with_initial_size(handles.workerStackBytes))
    handles.heatmapTextureBuilderHandle = WasmWorkerHandle(create_worker_with_initial_size(handles.workerStackBytes))
}

wasm_workers_terminate_all :: proc "contextless" (handles: ^WasmWorkerHandles) {
    if handles.websocketDecoderHandle > 0 {
        terminate_worker(i32(handles.websocketDecoderHandle))
        handles.websocketDecoderHandle = 0
    }
    if handles.indicatorComputeHandle > 0 {
        terminate_worker(i32(handles.indicatorComputeHandle))
        handles.indicatorComputeHandle = 0
    }
    if handles.heatmapTextureBuilderHandle > 0 {
        terminate_worker(i32(handles.heatmapTextureBuilderHandle))
        handles.heatmapTextureBuilderHandle = 0
    }
}
