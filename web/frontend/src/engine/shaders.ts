// WebGL2 GLSL 300 es shaders for instanced quad rendering
//
// Each instance is a rectangle defined by (x, y, width, height) in screen pixels
// and colored by (r, g, b, a). A single unit quad (0..1) is scaled/translated
// per instance in the vertex shader.
//
// Width sign acts as a "frame" flag:
//   width > 0  →  world-space quad: u_camera_x is subtracted from x
//                 (candles, wicks, VWAP segments, EMA, liquidations)
//   width < 0  →  screen-space quad: pinned to the viewport (no camera shift)
//                 (key levels, vol-profile bars, OBI bands). |width| is used.

export const VERTEX_SHADER = `#version 300 es
layout(location=0) in vec2 a_corner;
layout(location=1) in vec4 a_posSize;
layout(location=2) in vec4 a_color;

uniform vec2 u_resolution;
uniform float u_camera_x;
out vec4 v_color;

void main() {
    float w_signed = a_posSize.z;
    float w_abs    = abs(w_signed);
    float cam      = w_signed < 0.0 ? 0.0 : u_camera_x;
    vec2 size = vec2(w_abs, a_posSize.w);
    vec2 pos  = a_posSize.xy + a_corner * size;
    pos.x -= cam;
    vec2 clip = (pos / u_resolution) * 2.0 - 1.0;
    clip.y = -clip.y;
    gl_Position = vec4(clip, 0.0, 1.0);
    v_color = a_color;
}
`;

export const FRAGMENT_SHADER = `#version 300 es
precision mediump float;
in vec4 v_color;
out vec4 fragColor;
void main() {
    fragColor = v_color;
}
`;
