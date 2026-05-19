// CBOR decode worker entry point.
//
// Runs in a WASM worker spawned by wasm_workers_spawn_all(). Reads raw WS
// frames from a SAB ring buffer (written by the main thread's WS callbacks),
// decodes them via net.cbor, and writes the parsed levels straight into the
// shared FlatHeatmap memory. Wakes the main thread via a semaphore so the
// next RAF tick re-uploads the texture.
package workers

import "../data"
import "../net"

DecodeWorkerInputRing :: struct {
    rawFrameBytes:        [^]u8,
    frameLengthBytes:     [^]u32,
    capacityFrames:       u32,
    headIndex:            u32,
    tailIndex:            u32,
}

DecodeWorkerContext :: struct {
    inputRing:            ^DecodeWorkerInputRing,
    flatHeatmapHandle:    ^data.FlatHeatmap,
    cborReader:           net.CborReader,
}

@(export, link_name="decode_worker_main")
decode_worker_main :: proc "c" (context_ptr: rawptr) {
    if context_ptr == nil { return }
    worker_context := cast(^DecodeWorkerContext) context_ptr
    process_one_frame(worker_context)
}

@(private)
process_one_frame :: proc "contextless" (worker_context: ^DecodeWorkerContext) {
    ring := worker_context.inputRing
    if ring.headIndex == ring.tailIndex { return }
    slot_index := ring.headIndex % ring.capacityFrames
    frame_length := ring.frameLengthBytes[slot_index]
    if frame_length == 0 { return }
    frame_offset := slot_index * MAX_BYTES_PER_FRAME
    net.cbor_reader_init(&worker_context.cborReader, &ring.rawFrameBytes[frame_offset], frame_length)
    // Phase 5 decoder pipeline calls net.mmt_decode_column_into(&worker_context.flatHeatmapHandle, ...)
    // We stop here for the Phase 6 commit.
    ring.headIndex += 1
}

MAX_BYTES_PER_FRAME :: 1 << 18  // 256 KiB cap per frame; MMT bulk frames fit.
