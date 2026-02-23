// WebGL2 GLSL 300 es shaders for instanced quad rendering
//
// Each instance is a rectangle defined by (x, y, width, height) in screen pixels
// and colored by (r, g, b, a). A single unit quad (0..1) is scaled/translated
// per instance in the vertex shader.

export const VERTEX_SHADER = `#version 300 es
layout(location=0) in vec2 a_corner;
layout(location=1) in vec4 a_posSize;
layout(location=2) in vec4 a_color;

uniform vec2 u_resolution;
uniform float u_camera_x;
out vec4 v_color;

void main() {
    vec2 pos = a_posSize.xy + a_corner * a_posSize.zw;
    pos.x -= u_camera_x;
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
