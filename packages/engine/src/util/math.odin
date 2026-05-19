// Tiny inlined math helpers used by hot-path layers.
package util

clamp_int32 :: #force_inline proc "contextless" (value, low, high: i32) -> i32 {
    if value < low  { return low }
    if value > high { return high }
    return value
}

clamp_float64 :: #force_inline proc "contextless" (value, low, high: f64) -> f64 {
    if value < low  { return low }
    if value > high { return high }
    return value
}

linear_interpolate :: #force_inline proc "contextless" (start, end, t: f64) -> f64 {
    return start + (end - start) * t
}
