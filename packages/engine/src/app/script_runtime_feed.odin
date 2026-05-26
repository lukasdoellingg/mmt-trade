// Apply MMT script-runtime JSON plot updates to the terminal script overlay layer.
package app

import "../layers"

@(private="file")
script_runtime_layer_state: layers.ScriptRuntimeLayer

script_runtime_feed_init :: proc "contextless" () {
    layers.script_runtime_layer_init(&script_runtime_layer_state)
}

script_runtime_feed_layer :: proc "contextless" () -> ^layers.ScriptRuntimeLayer {
    return &script_runtime_layer_state
}

// Minimal JSON price extractor: scans for `"price":` and numeric tokens (UTF-8).
@(private)
try_parse_price_after_key :: proc "contextless" (text: []u8, key: string, start: int) -> (f64, bool) {
    key_len := len(key)
    limit := len(text) - key_len
    for index in start..<limit {
        match := true
        for key_index in 0..<key_len {
            if text[index + key_index] != key[key_index] {
                match = false
                break
            }
        }
        if !match { continue }
        cursor := index + key_len
        for cursor < len(text) && (text[cursor] == ' ' || text[cursor] == ':' || text[cursor] == '"') {
            cursor += 1
        }
        value: f64 = 0
        digits: int = 0
        sign: f64 = 1
        if cursor < len(text) && text[cursor] == '-' {
            sign = -1
            cursor += 1
        }
        for cursor < len(text) {
            ch := text[cursor]
            if ch >= '0' && ch <= '9' {
                value = value * 10 + f64(ch - '0')
                digits += 1
                cursor += 1
                continue
            }
            if ch == '.' && digits > 0 {
                frac: f64 = 0.1
                cursor += 1
                for cursor < len(text) {
                    ch2 := text[cursor]
                    if ch2 >= '0' && ch2 <= '9' {
                        value += f64(ch2 - '0') * frac
                        frac *= 0.1
                        cursor += 1
                    } else {
                        break
                    }
                }
                break
            }
            break
        }
        if digits > 0 && value * sign > 0 {
            return value * sign, true
        }
    }
    return 0, false
}

script_runtime_apply_json :: proc "contextless" (json_bytes: []u8, runtime_id: string) -> bool {
    if len(json_bytes) == 0 { return false }
    prices: [layers.MAX_PLOT_LINES]f64
    count: int = 0
    for scan_index in 0..<len(json_bytes) {
        if count >= layers.MAX_PLOT_LINES { break }
        if price, ok := try_parse_price_after_key(json_bytes, "\"price\"", scan_index); ok {
            prices[count] = price
            count += 1
            continue
        }
        if price, ok := try_parse_price_after_key(json_bytes, "\"y\"", scan_index); ok {
            prices[count] = price
            count += 1
            continue
        }
        if price, ok := try_parse_price_after_key(json_bytes, "\"level\"", scan_index); ok {
            prices[count] = price
            count += 1
        }
    }
    if count == 0 { return false }
    layers.script_runtime_set_plot_lines(
        &script_runtime_layer_state,
        prices[:count],
        runtime_id,
        110, 181, 255,
    )
    return true
}
