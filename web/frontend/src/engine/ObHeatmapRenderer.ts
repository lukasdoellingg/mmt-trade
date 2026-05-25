/**
 * GPU order-book heatmap (MMT.gg-style rolling time × price grid).
 * RG texture: R=ask intensity, G=bid intensity.
 */
const OB_VERT = `#version 300 es
layout(location=0) in vec2 a_pos;
out vec2 v_uv;
uniform vec2 u_resolution;
uniform vec4 u_plot;
void main() {
    v_uv = a_pos;
    vec2 px = u_plot.xy + a_pos * u_plot.zw;
    vec2 clip = (px / u_resolution) * 2.0 - 1.0;
    clip.y = -clip.y;
    gl_Position = vec4(clip, 0.0, 1.0);
}`;

const OB_FRAG = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_intensity;
out vec4 fragColor;
// Single-LUT green ramp keyed off total liquidity at this cell.
// Bid vs. ask is still in t.r / t.g but we deliberately mix them into a
// single intensity — MMT.gg's heatmap is monochrome-green on the chart;
// the side information lives in the ladder, not in the heatmap colour.
void main() {
    vec2 t = texture(u_tex, v_uv).rg;
    float sum = t.r + t.g;
    if (sum < 0.008) discard;
    // pow(.., 0.6) bends low values up (better visibility for the smooth
    // background gradient) while still letting hot spots punch above.
    float k = pow(min(sum, 1.0), 0.6);
    vec3 dim    = vec3(0.06, 0.22, 0.10);   // dark green wash
    vec3 bright = vec3(0.24, 0.86, 0.34);   // hot green spot
    vec3 col = mix(dim, bright, k);
    float a = clamp(k * u_intensity * 0.95, 0.0, 0.85);
    if (a < 0.012) discard;
    fragColor = vec4(col, a);
}`;

export const TIME_COLS = 768;
/** Vertical resolution (HD bins); SD merges via obColumn.downsampleColumnHdToSd */
export const PRICE_ROWS = 512;

export class ObHeatmapRenderer {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private texture: WebGLTexture;
  private texData: Uint8Array;
  private uResolution: WebGLUniformLocation;
  private uPlot: WebGLUniformLocation;
  private uIntensity: WebGLUniformLocation;
  private width = 0;
  private height = 0;
  private colIdx = 0;
  private dirtyColMin = TIME_COLS;
  private dirtyColMax = -1;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.texData = new Uint8Array(TIME_COLS * PRICE_ROWS * 2);

    const vs = this.compile(gl.VERTEX_SHADER, OB_VERT);
    const fs = this.compile(gl.FRAGMENT_SHADER, OB_FRAG);
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('OB heatmap program: ' + gl.getProgramInfoLog(prog));
    }
    this.program = prog;
    gl.deleteShader(vs);
    gl.deleteShader(fs);

    this.uResolution = gl.getUniformLocation(prog, 'u_resolution')!;
    this.uPlot = gl.getUniformLocation(prog, 'u_plot')!;
    this.uIntensity = gl.getUniformLocation(prog, 'u_intensity')!;
    const uTex = gl.getUniformLocation(prog, 'u_tex');
    if (uTex) gl.uniform1i(uTex, 0);

    const quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), gl.STATIC_DRAW);

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8, TIME_COLS, PRICE_ROWS, 0, gl.RG, gl.UNSIGNED_BYTE, this.texData);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);
  }

  resize(w: number, h: number) {
    this.width = w;
    this.height = h;
    this.gl.viewport(0, 0, w, h);
  }

  /** Shift history left and clear newest column */
  scrollColumn() {
    const rowBytes = PRICE_ROWS * 2;
    this.texData.copyWithin(0, rowBytes, TIME_COLS * rowBytes);
    this.texData.fill(0, (TIME_COLS - 1) * rowBytes);
    this.colIdx = TIME_COLS - 1;
    this.markAllColumnsDirty();
  }

  clearTexture() {
    this.texData.fill(0);
    this.markAllColumnsDirty();
  }

  private markColumnDirty(colIndex: number) {
    if (colIndex < this.dirtyColMin) this.dirtyColMin = colIndex;
    if (colIndex > this.dirtyColMax) this.dirtyColMax = colIndex;
  }

  private markAllColumnsDirty() {
    this.dirtyColMin = 0;
    this.dirtyColMax = TIME_COLS - 1;
  }

  private clearDirtyColumns() {
    this.dirtyColMin = TIME_COLS;
    this.dirtyColMax = -1;
  }

  /** Copy a pre-binned column into texture column index [0, TIME_COLS). */
  blitColumn(colIndex: number, src: Uint8Array) {
    if (colIndex < 0 || colIndex >= TIME_COLS) return;
    const base = colIndex * PRICE_ROWS * 2;
    const n = Math.min(PRICE_ROWS * 2, src.length);
    this.texData.set(src.subarray(0, n), base);
    this.markColumnDirty(colIndex);
  }

  getTextureBuffer(): Uint8Array {
    return this.texData;
  }

  /** Upload only columns marked dirty since last upload (partial texSubImage2D). */
  uploadDirtyColumns() {
    if (this.dirtyColMax < this.dirtyColMin) return 0;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    const rowBytes = PRICE_ROWS * 2;
    let bytes = 0;
    for (let c = this.dirtyColMin; c <= this.dirtyColMax; c++) {
      const base = c * rowBytes;
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        c,
        0,
        1,
        PRICE_ROWS,
        gl.RG,
        gl.UNSIGNED_BYTE,
        this.texData.subarray(base, base + rowBytes),
      );
      bytes += rowBytes;
    }
    this.clearDirtyColumns();
    return bytes;
  }

  /** Full texture upload — use only on init or explicit full rebuild. */
  uploadTexture() {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TIME_COLS, PRICE_ROWS, gl.RG, gl.UNSIGNED_BYTE, this.texData);
    this.clearDirtyColumns();
  }

  render(plotX: number, plotY: number, plotW: number, plotH: number, intensity = 1.15) {
    const gl = this.gl;
    gl.viewport(0, 0, this.width, this.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.uniform2f(this.uResolution, this.width, this.height);
    gl.uniform4f(this.uPlot, plotX, plotY, plotW, plotH);
    gl.uniform1f(this.uIntensity, intensity);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
  }

  private compile(type: number, src: string): WebGLShader {
    const gl = this.gl;
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(s);
      gl.deleteShader(s);
      throw new Error(info || 'shader compile failed');
    }
    return s;
  }
}
