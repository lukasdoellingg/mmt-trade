// ═══════════════════════════════════════════════════════════════
//  ChartRenderer — WebGL2 Instanced Quad Renderer
//
//  Draws up to 100,000 instanced quads in a SINGLE draw call.
//  Zero-GC render(): no `new`, no allocations in the hot path.
//  Buffers point directly into WASM linear memory (zero-copy).
// ═══════════════════════════════════════════════════════════════

import { VERTEX_SHADER, FRAGMENT_SHADER } from './shaders';

const MAX_INSTANCES = 20_000;

export class ChartRenderer {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private posVBO: WebGLBuffer;
  private colVBO: WebGLBuffer;
  private uResolution: WebGLUniformLocation;
  private width = 0;
  private height = 0;

  // Pre-allocated sub-views bound to WASM memory (set via bindBuffers)
  private posView: Float32Array | null = null;
  private colView: Float32Array | null = null;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;

    // Compile shaders
    const vs = this.compileShader(gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = this.compileShader(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);

    // Link program
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('Program link failed: ' + gl.getProgramInfoLog(prog));
    }
    this.program = prog;
    gl.deleteShader(vs);
    gl.deleteShader(fs);

    this.uResolution = gl.getUniformLocation(prog, 'u_resolution')!;

    // Create VAO
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);

    // Unit quad geometry (2 triangles, 6 vertices via index buffer)
    // Corners: (0,0), (1,0), (1,1), (0,1)
    const quadVerts = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
    const quadIndices = new Uint16Array([0, 1, 2, 0, 2, 3]);

    const quadVBO = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, quadVBO);
    gl.bufferData(gl.ARRAY_BUFFER, quadVerts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(0, 0); // per vertex

    const ebo = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, quadIndices, gl.STATIC_DRAW);

    // Instance position+size buffer (x, y, w, h) — 4 floats per instance
    this.posVBO = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posVBO);
    gl.bufferData(gl.ARRAY_BUFFER, MAX_INSTANCES * 16, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(1, 1); // per instance

    // Instance color buffer (r, g, b, a) — 4 floats per instance
    this.colVBO = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colVBO);
    gl.bufferData(gl.ARRAY_BUFFER, MAX_INSTANCES * 16, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(2, 1); // per instance

    gl.bindVertexArray(null);

    // GL state that never changes
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0.024, 0.024, 0.043, 1.0); // #06060b
  }

  /**
   * Bind WASM memory views. Called once after WASM loads,
   * and again if WASM memory grows.
   */
  bindBuffers(positions: Float32Array, colors: Float32Array): void {
    this.posView = positions;
    this.colView = colors;
  }

  resize(w: number, h: number): void {
    this.width = w;
    this.height = h;
    this.gl.viewport(0, 0, w, h);
  }

  clear(): void {
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
  }

  /**
   * Zero-GC render: upload WASM buffers to GPU, draw all instances.
   * No `new`, no allocations, no object creation.
   */
  render(instanceCount: number): void {
    if (instanceCount <= 0 || !this.posView || !this.colView) return;

    const gl = this.gl;
    const count = instanceCount > MAX_INSTANCES ? MAX_INSTANCES : instanceCount;

    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.uniform2f(this.uResolution, this.width, this.height);
    gl.bindVertexArray(this.vao);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.posVBO);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.posView, 0, count * 4);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.colVBO);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.colView, 0, count * 4);

    gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, count);
  }

  /**
   * Render from raw JS Float32Arrays (fallback when WASM is not available).
   */
  renderRaw(positions: Float32Array, colors: Float32Array, instanceCount: number): void {
    if (instanceCount <= 0) return;

    const gl = this.gl;
    const count = instanceCount > MAX_INSTANCES ? MAX_INSTANCES : instanceCount;

    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.uniform2f(this.uResolution, this.width, this.height);
    gl.bindVertexArray(this.vao);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.posVBO);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, positions, 0, count * 4);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.colVBO);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, colors, 0, count * 4);

    gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, count);
  }

  private compileShader(type: number, source: string): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error('Shader compile failed: ' + info);
    }
    return shader;
  }
}
