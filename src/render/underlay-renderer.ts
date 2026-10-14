import type { Affine2D, Bounds } from '@/core/types';
import type { RenderData, SegmentBatch, TriangleBatch } from '@/underlay/render-data';
import { SEG_STRIDE, TRI_STRIDE } from '@/underlay/render-data';
import type { ViewTransform } from '@/store/view';

import { batchClipTransform, worldToScreen } from './view';

/**
 * WebGL2 underlay renderer (decision D-2, option (a) with a minimal custom WebGL2 layer instead of
 * Three.js). Segments are drawn as instanced screen-space quads so lineweights, linetype patterns
 * and per-layer visibility (data texture lookup) are applied on the GPU; fills are triangles; PDF
 * pages are textured quads. Each batch carries float32 coordinates relative to its own origin and a
 * float64-derived transform (row 18).
 */

const SEG_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_corner;      // (t, side) t∈{0,1}, side∈{-1,1}
layout(location=1) in vec2 a_p0;
layout(location=2) in vec2 a_p1;
layout(location=3) in vec4 a_color;
layout(location=4) in float a_width;
layout(location=5) in float a_dist0;
layout(location=6) in vec2 a_layerPattern;
layout(location=7) in float a_ltscale;
uniform mat2 u_m;
uniform vec2 u_t;
uniform vec2 u_viewport;
uniform sampler2D u_layers;
uniform float u_lineScale;
out vec4 v_color;
out float v_dist;
flat out float v_pattern;
flat out float v_ltscale;
void main() {
  int layer = int(a_layerPattern.x);
  float vis = texelFetch(u_layers, ivec2(layer % 256, layer / 256), 0).r;
  vec2 c0 = u_m * a_p0 + u_t;
  vec2 c1 = u_m * a_p1 + u_t;
  vec2 s0 = c0 * u_viewport * 0.5;
  vec2 s1 = c1 * u_viewport * 0.5;
  vec2 d = s1 - s0;
  float len = length(d);
  vec2 dir = len > 1e-6 ? d / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float w = max(1.0, a_width * u_lineScale);
  vec2 s = mix(s0, s1, a_corner.x) + nrm * a_corner.y * w * 0.5 + dir * (a_corner.x * 2.0 - 1.0) * 0.5;
  gl_Position = vis < 0.5 ? vec4(2.0, 2.0, 2.0, 1.0) : vec4(s / (u_viewport * 0.5), 0.0, 1.0);
  v_color = a_color;
  v_dist = a_dist0 + a_corner.x * length(a_p1 - a_p0);
  v_pattern = a_layerPattern.y;
  v_ltscale = a_ltscale;
}`;

const SEG_FS = `#version 300 es
precision highp float;
in vec4 v_color;
in float v_dist;
flat in float v_pattern;
flat in float v_ltscale;
uniform sampler2D u_patterns;
uniform float u_pxPerUnit;
uniform float u_opacity;
uniform float u_ghost;
uniform float u_lightBg;
out vec4 o;
vec3 adapt(vec3 c) {
  // ACI 7 (white) and near-white become black on a light background.
  if (u_lightBg > 0.5 && c.r > 0.92 && c.g > 0.92 && c.b > 0.92) c = vec3(0.0);
  if (u_ghost > 0.5) {
    float g = dot(c, vec3(0.299, 0.587, 0.114));
    c = mix(vec3(g), u_lightBg > 0.5 ? vec3(1.0) : vec3(0.0), 0.55);
  }
  return c;
}
void main() {
  int p = int(v_pattern);
  if (p > 0) {
    float n = texelFetch(u_patterns, ivec2(0, p), 0).r;
    float total = texelFetch(u_patterns, ivec2(1, p), 0).r * v_ltscale;
    if (n > 0.0 && total * u_pxPerUnit > 3.0) {
      float pos = mod(v_dist, total);
      float acc = 0.0;
      bool draw = true;
      for (int k = 0; k < 14; k++) {
        if (float(k) >= n) break;
        float e = texelFetch(u_patterns, ivec2(2 + k, p), 0).r * v_ltscale;
        float l = abs(e);
        if (e == 0.0) l = 1.5 / u_pxPerUnit; // dot
        if (pos < acc + l) { draw = e >= 0.0; break; }
        acc += l;
      }
      if (!draw) discard;
    }
  }
  o = vec4(adapt(v_color.rgb), v_color.a * u_opacity);
}`;

const TRI_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_pos;
layout(location=1) in vec4 a_color;
layout(location=2) in float a_layer;
uniform mat2 u_m;
uniform vec2 u_t;
uniform sampler2D u_layers;
out vec4 v_color;
void main() {
  int layer = int(a_layer);
  float vis = texelFetch(u_layers, ivec2(layer % 256, layer / 256), 0).r;
  gl_Position = vis < 0.5 ? vec4(2.0, 2.0, 2.0, 1.0) : vec4(u_m * a_pos + u_t, 0.0, 1.0);
  v_color = a_color;
}`;

const TRI_FS = `#version 300 es
precision highp float;
in vec4 v_color;
uniform float u_opacity;
uniform float u_ghost;
uniform float u_lightBg;
out vec4 o;
void main() {
  vec3 c = v_color.rgb;
  if (u_lightBg > 0.5 && c.r > 0.92 && c.g > 0.92 && c.b > 0.92) c = vec3(0.0);
  if (u_ghost > 0.5) {
    float g = dot(c, vec3(0.299, 0.587, 0.114));
    c = mix(vec3(g), u_lightBg > 0.5 ? vec3(1.0) : vec3(0.0), 0.55);
  }
  o = vec4(c, v_color.a * u_opacity);
}`;

const TEX_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_uv;
uniform mat2 u_m;
uniform vec2 u_t;
uniform vec4 u_rect; // x, y, w, h relative to batch origin
out vec2 v_uv;
void main() {
  vec2 p = u_rect.xy + a_uv * u_rect.zw;
  gl_Position = vec4(u_m * p + u_t, 0.0, 1.0);
  v_uv = vec2(a_uv.x, 1.0 - a_uv.y);
}`;

const TEX_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_opacity;
uniform float u_ghost;
uniform float u_lightBg;
uniform float u_invert;
uniform float u_edge;
out vec4 o;
void main() {
  vec4 t = texture(u_tex, v_uv);
  vec3 c = t.rgb;
  // Edge-contrast enhancement for scanned pages (row 54): unsharp mask plus a contrast stretch that
  // darkens faint line work and whitens paper noise.
  if (u_edge > 0.0) {
    vec2 px = 1.0 / vec2(textureSize(u_tex, 0));
    vec3 n = texture(u_tex, v_uv + vec2(px.x, 0.0)).rgb + texture(u_tex, v_uv - vec2(px.x, 0.0)).rgb
           + texture(u_tex, v_uv + vec2(0.0, px.y)).rgb + texture(u_tex, v_uv - vec2(0.0, px.y)).rgb;
    c = clamp(c + u_edge * (4.0 * c - n), 0.0, 1.0);
    c = clamp((c - 0.55) * (1.0 + 1.5 * u_edge) + 0.55, 0.0, 1.0);
  }
  // White paper on a dark canvas: invert luminance only, so hues (e.g. blue vs red lines) are kept.
  if (u_invert > 0.5) c = clamp(c + vec3(1.0 - 2.0 * dot(c, vec3(0.299, 0.587, 0.114))), 0.0, 1.0);
  if (u_ghost > 0.5) {
    float g = dot(c, vec3(0.299, 0.587, 0.114));
    c = mix(vec3(g), u_lightBg > 0.5 ? vec3(1.0) : vec3(0.0), 0.55);
  }
  o = vec4(c, t.a * u_opacity);
}`;

interface GpuBatch {
  vao: WebGLVertexArrayObject;
  buffer: WebGLBuffer;
  count: number;
  ox: number;
  oy: number;
  bounds?: Bounds;
}

/** Whether a batch's bounds (drawing units) intersect the viewport (with a margin for line widths). */
function onScreen(
  b: Bounds | undefined,
  placement: Affine2D,
  view: ViewTransform,
  w: number,
  h: number,
): boolean {
  if (!b || !Number.isFinite(b.minX)) return true;
  const [a, bb, c, d, e, f] = placement;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of [
    [b.minX, b.minY],
    [b.maxX, b.minY],
    [b.maxX, b.maxY],
    [b.minX, b.maxY],
  ]) {
    const s = worldToScreen(view, w, h, { x: a * x + c * y + e, y: bb * x + d * y + f });
    if (s.x < minX) minX = s.x;
    if (s.y < minY) minY = s.y;
    if (s.x > maxX) maxX = s.x;
    if (s.y > maxY) maxY = s.y;
  }
  const m = 64;
  return maxX >= -m && minX <= w + m && maxY >= -m && minY <= h + m;
}

/** Bytes of vertex data uploaded per frame, so large drawings never block the UI (NFR-2). */
export const UPLOAD_BUDGET_BYTES = 8 * 1024 * 1024;

interface GpuTile {
  tex: WebGLTexture;
  x: number;
  y: number;
  w: number;
  h: number;
  key: string;
}

interface GpuDrawing {
  segs: GpuBatch[];
  tris: GpuBatch[];
  layers: WebGLTexture;
  patterns: WebGLTexture;
  tiles: GpuTile[];
  /** Batches waiting to be uploaded (see `uploadPending`). */
  pendingSegs?: SegmentBatch[];
  pendingTris?: TriangleBatch[];
}

export interface DrawingRenderState {
  id: string;
  placement: Affine2D;
  opacity: number;
  ghost: boolean;
  visible: boolean;
  /** True for raster/PDF pages that should be inverted on a dark canvas. */
  invertOnDark?: boolean;
}

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const prog = gl.createProgram()!;
  for (const [type, src] of [
    [gl.VERTEX_SHADER, vs],
    [gl.FRAGMENT_SHADER, fs],
  ] as const) {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS))
      throw new Error(`Shader error: ${gl.getShaderInfoLog(sh)}`);
    gl.attachShader(prog, sh);
  }
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
    throw new Error(`Program error: ${gl.getProgramInfoLog(prog)}`);
  return prog;
}

export class UnderlayRenderer {
  readonly gl: WebGL2RenderingContext;
  private segProg: WebGLProgram;
  private triProg: WebGLProgram;
  private texProg: WebGLProgram;
  private cornerBuf: WebGLBuffer;
  private quadVao: WebGLVertexArrayObject;
  private drawings = new Map<string, GpuDrawing>();
  private uniformCache = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();
  lineScale = 1;
  /** Edge-contrast enhancement of raster tiles, 0 (off) … 1 (row 54). */
  edgeContrast = 0;

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      antialias: true,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    this.segProg = compile(gl, SEG_VS, SEG_FS);
    this.triProg = compile(gl, TRI_VS, TRI_FS);
    this.texProg = compile(gl, TEX_VS, TEX_FS);
    // Quad corners for instanced segments: (t, side)
    this.cornerBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, -1, 1, -1, 0, 1, 1, 1]), gl.STATIC_DRAW);
    this.quadVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.quadVao);
    const qb = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, qb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  private u(prog: WebGLProgram, name: string) {
    let m = this.uniformCache.get(prog);
    if (!m) this.uniformCache.set(prog, (m = new Map()));
    if (!m.has(name)) m.set(name, this.gl.getUniformLocation(prog, name));
    return m.get(name)!;
  }

  hasDrawing(id: string) {
    return this.drawings.has(id);
  }

  /**
   * Registers render data for a drawing (replacing any previous data). Vertex data is uploaded
   * incrementally by `uploadPending` (a few MB per frame) so that big drawings keep the UI
   * responsive; batches appear as they are uploaded.
   */
  setDrawing(id: string, data: RenderData, layerCount: number) {
    this.removeDrawing(id);
    const gl = this.gl;
    const layers = gl.createTexture()!;
    const patterns = gl.createTexture()!;
    this.drawings.set(id, {
      segs: [],
      tris: [],
      layers,
      patterns,
      tiles: [],
      pendingSegs: [...data.segments],
      pendingTris: [...data.triangles],
    });
    this.setLayerVisibility(id, new Uint8Array(Math.max(1, layerCount)).fill(1));
    gl.bindTexture(gl.TEXTURE_2D, patterns);
    const rows = Math.max(1, data.patterns.length / 16);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 16, rows, 0, gl.RED, gl.FLOAT, data.patterns);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  }

  /** Uploads queued vertex data up to `budget` bytes; returns true while more is pending. */
  uploadPending(budget = UPLOAD_BUDGET_BYTES): boolean {
    let used = 0;
    let more = false;
    for (const d of this.drawings.values()) {
      while (d.pendingTris?.length && used < budget) {
        const b = d.pendingTris.shift()!;
        d.tris.push(this.uploadTris(b));
        used += b.data.byteLength;
      }
      while (d.pendingSegs?.length && used < budget) {
        const b = d.pendingSegs.shift()!;
        d.segs.push(this.uploadSegs(b));
        used += b.data.byteLength;
      }
      if (d.pendingSegs?.length || d.pendingTris?.length) more = true;
    }
    return more;
  }

  private uploadSegs(b: SegmentBatch): GpuBatch {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const buffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, b.data, gl.STATIC_DRAW);
    const attr = (loc: number, size: number, type: number, norm: boolean, offset: number) => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, type, norm, SEG_STRIDE, offset);
      gl.vertexAttribDivisor(loc, 1);
    };
    attr(1, 2, gl.FLOAT, false, 0);
    attr(2, 2, gl.FLOAT, false, 8);
    attr(3, 4, gl.UNSIGNED_BYTE, true, 16);
    attr(4, 1, gl.FLOAT, false, 20);
    attr(5, 1, gl.FLOAT, false, 24);
    attr(6, 2, gl.UNSIGNED_SHORT, false, 28);
    attr(7, 1, gl.FLOAT, false, 32);
    gl.bindVertexArray(null);
    return { vao, buffer, count: b.count, ox: b.ox, oy: b.oy, bounds: b.bounds };
  }

  private uploadTris(b: TriangleBatch): GpuBatch {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const buffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, b.data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, TRI_STRIDE, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, TRI_STRIDE, 8);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.UNSIGNED_SHORT, false, TRI_STRIDE, 12);
    gl.bindVertexArray(null);
    return { vao, buffer, count: b.count, ox: b.ox, oy: b.oy, bounds: b.bounds };
  }

  /** Creates an (empty) entry for drawings rendered only as raster tiles (PDF). */
  ensureDrawing(id: string) {
    if (this.drawings.has(id)) return;
    const gl = this.gl;
    const layers = gl.createTexture()!;
    const patterns = gl.createTexture()!;
    this.drawings.set(id, { segs: [], tris: [], layers, patterns, tiles: [] });
    this.setLayerVisibility(id, new Uint8Array([1]));
    gl.bindTexture(gl.TEXTURE_2D, patterns);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 16, 1, 0, gl.RED, gl.FLOAT, new Float32Array(16));
  }

  setLayerVisibility(id: string, visible: Uint8Array) {
    const d = this.drawings.get(id);
    if (!d) return;
    const gl = this.gl;
    const rows = Math.max(1, Math.ceil(visible.length / 256));
    const data = new Uint8Array(256 * rows);
    for (let i = 0; i < visible.length; i++) data[i] = visible[i] ? 255 : 0;
    gl.bindTexture(gl.TEXTURE_2D, d.layers);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 256, rows, 0, gl.RED, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  }

  /** Replaces raster tiles of a drawing (PDF). Tiles are in drawing units (y up). */
  setTiles(
    id: string,
    tiles: { key: string; x: number; y: number; w: number; h: number; image: TexImageSource }[],
  ) {
    const d = this.drawings.get(id);
    if (!d) return;
    const gl = this.gl;
    const keep = new Set(tiles.map((t) => t.key));
    for (const t of d.tiles) if (!keep.has(t.key)) gl.deleteTexture(t.tex);
    const existing = new Map(d.tiles.filter((t) => keep.has(t.key)).map((t) => [t.key, t]));
    d.tiles = tiles.map((t) => {
      const ex = existing.get(t.key);
      if (ex) return ex;
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, t.image);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return { tex, x: t.x, y: t.y, w: t.w, h: t.h, key: t.key };
    });
  }

  tileKeys(id: string): Set<string> {
    return new Set(this.drawings.get(id)?.tiles.map((t) => t.key) ?? []);
  }

  removeDrawing(id: string) {
    const d = this.drawings.get(id);
    if (!d) return;
    const gl = this.gl;
    for (const b of [...d.segs, ...d.tris]) {
      gl.deleteBuffer(b.buffer);
      gl.deleteVertexArray(b.vao);
    }
    for (const t of d.tiles) gl.deleteTexture(t.tex);
    gl.deleteTexture(d.layers);
    gl.deleteTexture(d.patterns);
    this.drawings.delete(id);
  }

  resize(cssW: number, cssH: number, dpr: number) {
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  render(view: ViewTransform, cssW: number, cssH: number, drawings: DrawingRenderState[], lightBg: boolean) {
    const gl = this.gl;
    const dpr = this.canvas.width / Math.max(1, cssW);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    for (const ds of drawings) {
      if (!ds.visible) continue;
      const d = this.drawings.get(ds.id);
      if (!d) continue;
      const det = Math.abs(ds.placement[0] * ds.placement[3] - ds.placement[1] * ds.placement[2]);
      const pxPerUnit = view.scale * Math.sqrt(det);
      // Raster tiles.
      if (d.tiles.length) {
        gl.useProgram(this.texProg);
        gl.bindVertexArray(this.quadVao);
        gl.activeTexture(gl.TEXTURE0);
        gl.uniform1i(this.u(this.texProg, 'u_tex'), 0);
        gl.uniform1f(this.u(this.texProg, 'u_opacity'), ds.opacity);
        gl.uniform1f(this.u(this.texProg, 'u_ghost'), ds.ghost ? 1 : 0);
        gl.uniform1f(this.u(this.texProg, 'u_lightBg'), lightBg ? 1 : 0);
        gl.uniform1f(this.u(this.texProg, 'u_invert'), !lightBg && ds.invertOnDark ? 1 : 0);
        gl.uniform1f(this.u(this.texProg, 'u_edge'), this.edgeContrast);
        for (const t of d.tiles) {
          const { m, t: tr } = batchClipTransform(view, cssW, cssH, ds.placement, t.x, t.y);
          gl.uniformMatrix2fv(this.u(this.texProg, 'u_m'), false, m);
          gl.uniform2fv(this.u(this.texProg, 'u_t'), tr);
          gl.uniform4f(this.u(this.texProg, 'u_rect'), 0, 0, t.w, t.h);
          gl.bindTexture(gl.TEXTURE_2D, t.tex);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        }
      }
      // Fills.
      if (d.tris.length) {
        gl.useProgram(this.triProg);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, d.layers);
        gl.uniform1i(this.u(this.triProg, 'u_layers'), 0);
        gl.uniform1f(this.u(this.triProg, 'u_opacity'), ds.opacity);
        gl.uniform1f(this.u(this.triProg, 'u_ghost'), ds.ghost ? 1 : 0);
        gl.uniform1f(this.u(this.triProg, 'u_lightBg'), lightBg ? 1 : 0);
        for (const b of d.tris) {
          if (!onScreen(b.bounds, ds.placement, view, cssW, cssH)) continue;
          const { m, t } = batchClipTransform(view, cssW, cssH, ds.placement, b.ox, b.oy);
          gl.uniformMatrix2fv(this.u(this.triProg, 'u_m'), false, m);
          gl.uniform2fv(this.u(this.triProg, 'u_t'), t);
          gl.bindVertexArray(b.vao);
          gl.drawArrays(gl.TRIANGLES, 0, b.count);
        }
      }
      // Lines.
      if (d.segs.length) {
        gl.useProgram(this.segProg);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, d.layers);
        gl.uniform1i(this.u(this.segProg, 'u_layers'), 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, d.patterns);
        gl.uniform1i(this.u(this.segProg, 'u_patterns'), 1);
        gl.uniform2f(this.u(this.segProg, 'u_viewport'), this.canvas.width, this.canvas.height);
        gl.uniform1f(this.u(this.segProg, 'u_lineScale'), dpr * this.lineScale);
        gl.uniform1f(this.u(this.segProg, 'u_pxPerUnit'), pxPerUnit);
        gl.uniform1f(this.u(this.segProg, 'u_opacity'), ds.opacity);
        gl.uniform1f(this.u(this.segProg, 'u_ghost'), ds.ghost ? 1 : 0);
        gl.uniform1f(this.u(this.segProg, 'u_lightBg'), lightBg ? 1 : 0);
        for (const b of d.segs) {
          if (!onScreen(b.bounds, ds.placement, view, cssW, cssH)) continue;
          const { m, t } = batchClipTransform(view, cssW, cssH, ds.placement, b.ox, b.oy);
          gl.uniformMatrix2fv(this.u(this.segProg, 'u_m'), false, m);
          gl.uniform2fv(this.u(this.segProg, 'u_t'), t);
          gl.bindVertexArray(b.vao);
          gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, b.count);
        }
      }
    }
    gl.bindVertexArray(null);
  }

  dispose() {
    for (const id of [...this.drawings.keys()]) this.removeDrawing(id);
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
