// ═══════════════════════════════════════════════════════════════
//  ChartRenderer — WebGL2 Instanced Quad Renderer
//
//  Draws up to 50,000 instanced quads in a SINGLE draw call.
//  Zero-GC hot path: no `new`, no allocations in render methods.
//  Buffers point directly into WASM linear memory (zero-copy).
//
//  uploadAndRender(): uploads pos/col to GPU, draws (buffer recompute)
//  renderCached():    draws with existing GPU data (pan hot path)
//  setCameraX():      updates horizontal camera offset uniform
// ═══════════════════════════════════════════════════════════════

import { VERTEX_SHADER, FRAGMENT_SHADER } from './shaders';

const MAX_INSTANCES = 50_000;

export class ChartRenderer {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private posVBO: WebGLBuffer;
  private colVBO: WebGLBuffer;
  private uResolution: WebGLUniformLocation;
  private uCameraX: WebGLUniformLocation;
  private width = 0;
  private height = 0;
  private currentCameraX = 0;
  private uploadedVersion = -1;

  private posView: Float32Array | null = null;
  private colView: Float32Array | null = null;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;

    const vs = this.compileShader(gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = this.compileShader(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);

    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('Program link: ' + gl.getProgramInfoLog(prog));
    }
    this.program = prog;
    gl.deleteShader(vs);
    gl.deleteShader(fs);

    this.uResolution = gl.getUniformLocation(prog, 'u_resolution')!;
    this.uCameraX = gl.getUniformLocation(prog, 'u_camera_x')!;

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);

    // Unit quad geometry (shared across all instances)
    const quadVBO = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, quadVBO);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(0, 0);

    const ebo = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);

    // Per-instance position buffer (x, y, w, h)
    this.posVBO = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posVBO);
    gl.bufferData(gl.ARRAY_BUFFER, MAX_INSTANCES * 16, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(1, 1);

    // Per-instance color buffer (r, g, b, a)
    this.colVBO = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colVBO);
    gl.bufferData(gl.ARRAY_BUFFER, MAX_INSTANCES * 16, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(2, 1);

    gl.bindVertexArray(null);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0.0, 0.0, 0.0, 0.0); // transparent — grid canvas shows through
  }

  bindBuffers(positions: Float32Array, colors: Float32Array): void {
    this.posView = positions;
    this.colView = colors;
  }

  resize(w: number, h: number): void {
    this.width = w;
    this.height = h;
    this.gl.viewport(0, 0, w, h);
  }

  setCameraX(x: number): void {
    this.currentCameraX = x;
  }

  clear(): void {
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
  }

  uploadAndRender(instanceCount: number, version: number): void {
    if (instanceCount <= 0 || !this.posView || !this.colView) return;
    const gl = this.gl;
    const count = Math.min(instanceCount, MAX_INSTANCES);

    if (version !== this.uploadedVersion) {
      this.uploadedVersion = version;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.posVBO);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.posView, 0, count * 4);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.colVBO);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.colView, 0, count * 4);
    }

    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.uniform2f(this.uResolution, this.width, this.height);
    gl.uniform1f(this.uCameraX, this.currentCameraX);
    gl.bindVertexArray(this.vao);
    gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, count);
  }

  renderCached(instanceCount: number): void {
    if (instanceCount <= 0) return;
    const gl = this.gl;
    const count = Math.min(instanceCount, MAX_INSTANCES);

    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.uniform2f(this.uResolution, this.width, this.height);
    gl.uniform1f(this.uCameraX, this.currentCameraX);
    gl.bindVertexArray(this.vao);
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
      throw new Error('Shader: ' + info);
    }
    return shader;
  }
}
