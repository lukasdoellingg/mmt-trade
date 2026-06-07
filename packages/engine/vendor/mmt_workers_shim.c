// Thin C wrappers for Emscripten WASM worker API (linked into chart_runtime.wasm).
#include <emscripten/wasm_worker.h>

int mmt_create_wasm_worker(int stack_bytes) {
  return (int)emscripten_malloc_wasm_worker((size_t)stack_bytes);
}

void mmt_post_wasm_worker(int worker, void (*fn)(void)) {
  emscripten_wasm_worker_post_function_v(worker, fn);
}

void mmt_terminate_wasm_worker(int worker) {
  emscripten_terminate_wasm_worker(worker);
}
