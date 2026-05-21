// Native CBOR regression test — validates Odin decoder against MMT captures.
//
//   bash packages/engine/scripts/test-cbor.sh
package cbor_test

import "core:fmt"
import "core:os"
import "data"
import "net"

EXPECTED_TS :: i64(1779193456)
EXPECTED_LAST_PRICE :: f32(76748.07)
EXPECTED_ASK_LEVELS :: i32(22479)
EXPECTED_BID_LEVELS :: i32(21888)

main :: proc() {
    repo_root := os.get_env("MMT_REPO_ROOT", context.temp_allocator)
    if repo_root == "" {
        repo_root = "../../.."
    }

    failures: int = 0
    mini_path := resolve_fixture(repo_root, "mmt-column-mini.bin")
    failures += run_fixture(mini_path, false, false, 1700000000, 2, 1, 100.5) ? 0 : 1
    heatmap_path := resolve_fixture(repo_root, "mmt-heatmap-column.bin")
    failures += run_fixture(heatmap_path, true, true, EXPECTED_TS, EXPECTED_ASK_LEVELS, EXPECTED_BID_LEVELS, EXPECTED_LAST_PRICE) ? 0 : 1
    column_path := resolve_fixture(repo_root, "mmt-column-only.bin")
    failures += run_fixture(column_path, false, true, EXPECTED_TS, EXPECTED_ASK_LEVELS, EXPECTED_BID_LEVELS, EXPECTED_LAST_PRICE) ? 0 : 1

    if failures > 0 {
        fmt.eprintf("[cbor-test] %d fixture(s) failed\n", failures)
        os.exit(1)
    }
    fmt.println("[cbor-test] OK — Odin decoder matches MMT capture")
}

resolve_fixture :: proc(repo_root: string, name: string) -> string {
    tests_path := fmt.tprintf("%s/tests/fixtures/%s", repo_root, name)
    if os.exists(tests_path) {
        return tests_path
    }
    return fmt.tprintf("%s/docs/captures/%s", repo_root, name)
}

run_fixture :: proc(path: string, full_frame: bool, optional: bool, expect_ts: i64, expect_asks: i32, expect_bids: i32, expect_lp: f32) -> bool {
    if !os.exists(path) {
        if optional {
            fmt.printf("[cbor-test] skip (missing optional fixture): %s\n", path)
            return true
        }
        fmt.eprintf("[cbor-test] required fixture missing: %s\n", path)
        return false
    }

    file_bytes, read_err := os.read_entire_file_from_path(path, context.temp_allocator)
    if read_err != nil {
        fmt.eprintf("[cbor-test] cannot read %s: %v\n", path, read_err)
        return false
    }

    frame_reader: net.CborReader
    net.cbor_reader_init(&frame_reader, raw_data(file_bytes), u32(len(file_bytes)))

    column_reader: net.CborReader
    if full_frame {
        if !net.mmt_cbor_open_heatmap_column(&frame_reader, &column_reader) {
            fmt.eprintf("[cbor-test] unwrap failed: %s\n", path)
            return false
        }
    } else {
        column_reader = frame_reader
    }

    volume_storage: [data.HEATMAP_LEVELS_PER_COLUMN]f32
    timestamp_storage: [1]i64
    heatmap: data.FlatHeatmap
    data.flat_heatmap_init(&heatmap, &volume_storage[0], &timestamp_storage[0], 0, 1)

    result: net.HeatmapEnvelopeDecodeResult
    if !net.mmt_decode_heatmap_column_into(&column_reader, &heatmap, 0, &result) {
        fmt.eprintf("[cbor-test] decode failed: %s\n", path)
        return false
    }

    if result.openTimestampSeconds != expect_ts {
        fmt.eprintf("[cbor-test] ts want %d got %d (%s)\n", expect_ts, result.openTimestampSeconds, path)
        return false
    }
    if result.askLevelCount != expect_asks {
        fmt.eprintf("[cbor-test] asks want %d got %d (%s)\n", expect_asks, result.askLevelCount, path)
        return false
    }
    if result.bidLevelCount != expect_bids {
        fmt.eprintf("[cbor-test] bids want %d got %d (%s)\n", expect_bids, result.bidLevelCount, path)
        return false
    }
    if abs(result.lastPrice - expect_lp) > 0.01 {
        fmt.eprintf("[cbor-test] lp want %f got %f (%s)\n", expect_lp, result.lastPrice, path)
        return false
    }

    fmt.printf("[cbor-test] pass %s (asks=%d bids=%d lp=%.2f)\n", path, result.askLevelCount, result.bidLevelCount, result.lastPrice)
    return true
}
