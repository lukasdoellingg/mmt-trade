// Emscripten WASM Worker bindings via C shim (vendor/mmt_workers_shim.c).
package workers

WasmWorkerHandle :: distinct i32

foreign _ {
    @(link_name="mmt_create_wasm_worker")
    create_wasm_worker :: proc "c" (worker_stack_size_bytes: i32) -> i32 ---

    @(link_name="mmt_post_wasm_worker")
    post_wasm_worker :: proc "c" (worker: i32, exported_function_ptr: rawptr) ---

    @(link_name="mmt_terminate_wasm_worker")
    terminate_wasm_worker :: proc "c" (worker: i32) ---
}

WasmWorkerHandles :: struct {
    websocketDecoderHandle:        WasmWorkerHandle,
    indicatorComputeHandle:        WasmWorkerHandle,
    heatmapTextureBuilderHandle:   WasmWorkerHandle,
    workerStackBytes:              i32,
}

DEFAULT_WORKER_STACK_BYTES :: 1024 * 1024

wasm_workers_spawn_all :: proc "contextless" (handles: ^WasmWorkerHandles) {
    if handles.workerStackBytes <= 0 {
        handles.workerStackBytes = DEFAULT_WORKER_STACK_BYTES
    }
    handles.websocketDecoderHandle = WasmWorkerHandle(create_wasm_worker(handles.workerStackBytes))
    handles.indicatorComputeHandle = WasmWorkerHandle(create_wasm_worker(handles.workerStackBytes))
    handles.heatmapTextureBuilderHandle = WasmWorkerHandle(create_wasm_worker(handles.workerStackBytes))
}

wasm_workers_terminate_all :: proc "contextless" (handles: ^WasmWorkerHandles) {
    if handles.websocketDecoderHandle > 0 {
        terminate_wasm_worker(i32(handles.websocketDecoderHandle))
        handles.websocketDecoderHandle = 0
    }
    if handles.indicatorComputeHandle > 0 {
        terminate_wasm_worker(i32(handles.indicatorComputeHandle))
        handles.indicatorComputeHandle = 0
    }
    if handles.heatmapTextureBuilderHandle > 0 {
        terminate_wasm_worker(i32(handles.heatmapTextureBuilderHandle))
        handles.heatmapTextureBuilderHandle = 0
    }
}

post_function_void :: proc "contextless" (worker: i32, exported_function_ptr: rawptr) {
    post_wasm_worker(worker, exported_function_ptr)
}
