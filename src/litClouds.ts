// Low cloud slab raymarched in post and lit from below by the streetlights.
// Navara's FogLight is homogeneous and Takram clouds only take sun/sky light,
// so neither can show lamp-lit clouds. Lamps are splatted into a mipmapped
// 2D density map; a cloud sample at height h above the lamps reads the mip
// whose footprint is ~h, i.e. the lamps that can actually reach it.
import ThreeView, {
  Effect,
  EffectDesc,
  geodeticToVector3,
  type EffectConfig,
  type EffectUpdate,
  type ViewContext,
} from "@navaramap/three";
import { BlendFunction, Effect as PPEffect } from "postprocessing";
import {
  Color,
  Data3DTexture,
  DataTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix3,
  Matrix4,
  RedFormat,
  RepeatWrapping,
  RGBAFormat,
  Uniform,
  UnsignedByteType,
  Vector2,
  Vector3,
  Vector4,
  type PerspectiveCamera,
  type Texture,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from "three";

export type LitCloudsParams = {
  coverage: number;
  base: number; // m above ellipsoid
  thickness: number;
  density: number; // extinction per metre at full density
  detail: number;
  scale: number; // metres per noise tile
  stretch: number; // vertical squash, >1 = flatter wisps
  wind: number; // m/s, toward +east
  glow: number; // lamp light on clouds
  falloff: number; // m, lamp light height falloff
  skyGlow: number; // flat orange city glow
  opacity: number; // how much the clouds hide what's behind them
};

const FRAG = /* glsl */ `
uniform highp sampler2D uDepth;
uniform float uDepthPacked;
uniform sampler2D uLampMap;
uniform highp sampler3D uNoise;
uniform mat4 uInvProj;
uniform mat3 uViewToLocal;
uniform vec3 uCamLocal;
uniform float uFar;
uniform vec4 uMapRect;
uniform float uMapTexel;
uniform float uMapNorm;
uniform float uMapMaxLod;
uniform float uBase;
uniform float uThick;
uniform float uCoverage;
uniform float uDensity;
uniform float uDetail;
uniform float uScale;
uniform float uStretch;
uniform vec2 uWindOffset;
uniform float uGlow;
uniform float uFalloff;
uniform float uSkyGlow;
uniform float uOpacity;
uniform vec3 uLightColor;
uniform float uTime;
uniform float uMaxDist;

float lcReadDepth(vec2 uv) {
  vec4 v = texture(uDepth, uv);
  // three's RGBADepthPacking (UnpackFactors4)
  return uDepthPacked > 0.5
    ? dot(v, vec4(255.0 / 256.0, 255.0 / 65536.0, 255.0 / 16777216.0, 1.0 / 16777216.0))
    : v.r;
}

float lcRemap(float x, float a, float b) {
  return clamp((x - a) / max(b - a, 1e-4), 0.0, 1.0);
}

float lcDensity(vec3 p) {
  float h = (p.z - uBase) / uThick;
  if (h <= 0.0 || h >= 1.0) return 0.0;
  vec3 q = vec3(p.xy - uWindOffset, p.z * uStretch) / uScale;
  float shape = texture(uNoise, q).r;
  float profile = smoothstep(0.0, 0.3, h) * smoothstep(1.0, 0.45, h);
  float c = lcRemap(shape * profile, 1.0 - uCoverage, 1.0);
  if (c <= 0.0) return 0.0;
  float detail = texture(uNoise, q * 5.3 + vec3(0.37, 0.11, 0.73)).r;
  return lcRemap(c, detail * uDetail * 0.6, 1.0);
}

float lcLamps(vec3 p) {
  vec2 uv = (p.xy - uMapRect.xy) * uMapRect.zw;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return 0.0;
  // Mean lamp elevation from a ~250 m footprint
  vec4 coarse = textureLod(uLampMap, uv, 5.0);
  float lampZ = coarse.r > 1e-5 ? coarse.g / coarse.r : uBase;
  // Light spreads below the lamps too; never read finer than ~3 texels so a
  // lamp stays a soft blob rather than its texel footprint
  float h = max(abs(p.z - lampZ), 3.0 * uMapTexel);
  float lod = clamp(log2(h / uMapTexel), 0.0, uMapMaxLod);
  float c = textureLod(uLampMap, uv, lod).r * uMapNorm;
  float k = h / uFalloff;
  return c / (1.0 + k * k);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  outputColor = inputColor;
  if (uDensity <= 0.0 || uCoverage <= 0.0 || uThick <= 0.0) return;

  vec4 v = uInvProj * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
  vec3 dirView = normalize(v.xyz / v.w);
  float w = pow(2.0, lcReadDepth(uv) * log2(uFar + 1.0)) - 1.0;
  float tScene = w / max(-dirView.z, 1e-4);
  vec3 dir = normalize(uViewToLocal * dirView);

  float z0 = uBase, z1 = uBase + uThick;
  float t0, t1;
  if (abs(dir.z) < 1e-5) {
    if (uCamLocal.z < z0 || uCamLocal.z > z1) return;
    t0 = 0.0; t1 = uMaxDist;
  } else {
    float ta = (z0 - uCamLocal.z) / dir.z;
    float tb = (z1 - uCamLocal.z) / dir.z;
    t0 = max(min(ta, tb), 0.0);
    t1 = max(ta, tb);
  }
  t1 = min(t1, min(tScene, uMaxDist));
  if (t1 <= t0) return;

  const int STEPS = 48;
  float dt = (t1 - t0) / float(STEPS);
  float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))) + uTime * 0.618034);
  float T = 1.0;
  vec3 L = vec3(0.0);
  for (int i = 0; i < STEPS; i++) {
    vec3 p = uCamLocal + dir * (t0 + (float(i) + jitter) * dt);
    float d = lcDensity(p);
    if (d <= 0.0) continue;
    float sigma = d * uDensity;
    float Ts = exp(-sigma * dt);
    // Light from below crosses some cloud under this sample; kept gentle so
    // dense cores still glow instead of punching black holes
    float shadow = exp(-sigma * (p.z - uBase) * 0.15);
    float E = uGlow * lcLamps(p) * shadow + uSkyGlow;
    L += T * (1.0 - Ts) * E * uLightColor;
    T *= Ts;
    if (T < 0.01) break;
  }
  outputColor = vec4(inputColor.rgb * mix(1.0, T, uOpacity) + L, inputColor.a);
}
`;

// Local east/north/up frame so the shader works in small numbers
export class LocalFrame {
  readonly origin: Vector3;
  readonly ecefToLocal = new Matrix3();

  constructor(lat: number, lng: number) {
    const p = (lat: number, lng: number, height: number) => {
      const { x, y, z } = geodeticToVector3({ lat, lng, height });
      return new Vector3(x, y, z);
    };
    this.origin = p(lat, lng, 0);
    const up = p(lat, lng, 1).sub(this.origin).normalize();
    const east = p(lat, lng + 1e-4, 0).sub(this.origin);
    east.sub(up.clone().multiplyScalar(east.dot(up))).normalize();
    const north = new Vector3().crossVectors(up, east);
    this.ecefToLocal.set(
      east.x, east.y, east.z,
      north.x, north.y, north.z,
      up.x, up.y, up.z,
    );
  }

  toLocal(ecef: { x: number; y: number; z: number }) {
    return new Vector3(ecef.x, ecef.y, ecef.z)
      .sub(this.origin)
      .applyMatrix3(this.ecefToLocal);
  }
}

const MAP_SIZE = 512;
const MAP_MARGIN = 500;
const SPLAT_SIGMA = 1.5; // texels

function buildLampMap(lamps: Vector3[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const l of lamps) {
    x0 = Math.min(x0, l.x); y0 = Math.min(y0, l.y);
    x1 = Math.max(x1, l.x); y1 = Math.max(y1, l.y);
  }
  x0 -= MAP_MARGIN; y0 -= MAP_MARGIN;
  const span = Math.max(x1 - x0, y1 - y0) + MAP_MARGIN;
  const texel = span / MAP_SIZE;

  // R = lamp count, G = count * elevation (mean elevation survives mipping)
  let level = new Float32Array(MAP_SIZE * MAP_SIZE * 4);
  // Gaussian splat at the lamp's sub-texel position; a single-texel box
  // reads as a glowing square column when clouds sink to lamp height
  const R = Math.ceil(SPLAT_SIGMA * 3);
  const weights: number[] = [];
  for (const l of lamps) {
    const fx = (l.x - x0) / texel - 0.5;
    const fy = (l.y - y0) / texel - 0.5;
    const ci = Math.round(fx), cj = Math.round(fy);
    weights.length = 0;
    let sum = 0;
    for (let dj = -R; dj <= R; dj++)
      for (let di = -R; di <= R; di++) {
        const dx = ci + di - fx, dy = cj + dj - fy;
        const w = Math.exp(-(dx * dx + dy * dy) / (2 * SPLAT_SIGMA * SPLAT_SIGMA));
        weights.push(w);
        sum += w;
      }
    let n = 0;
    for (let dj = -R; dj <= R; dj++)
      for (let di = -R; di <= R; di++) {
        const w = weights[n++] / sum;
        const i = ci + di, j = cj + dj;
        if (i < 0 || j < 0 || i >= MAP_SIZE || j >= MAP_SIZE) continue;
        const k = (j * MAP_SIZE + i) * 4;
        level[k] += w;
        level[k + 1] += w * l.z;
      }
  }
  const mipmaps: { data: Uint16Array; width: number; height: number }[] = [];
  let size = MAP_SIZE;
  for (;;) {
    mipmaps.push({
      data: Uint16Array.from(level, (v) => DataUtils.toHalfFloat(v)),
      width: size,
      height: size,
    });
    if (size === 1) break;
    const half = size / 2;
    const next = new Float32Array(half * half * 4);
    for (let j = 0; j < half; j++)
      for (let i = 0; i < half; i++)
        for (let c = 0; c < 4; c++) {
          const a = (2 * j * size + 2 * i) * 4 + c;
          next[(j * half + i) * 4 + c] =
            (level[a] + level[a + 4] + level[a + size * 4] + level[a + size * 4 + 4]) / 4;
        }
    level = next;
    size = half;
  }

  const tex = new DataTexture(mipmaps[0].data, MAP_SIZE, MAP_SIZE, RGBAFormat, HalfFloatType);
  tex.mipmaps = mipmaps;
  tex.generateMipmaps = false;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.magFilter = LinearFilter;
  tex.needsUpdate = true;

  // Normalise so the neighbourhood-average lamp density reads ~1
  const avgPerTexel = lamps.length / (((x1 - x0 - MAP_MARGIN) * (y1 - y0 - MAP_MARGIN)) / (texel * texel));
  return {
    tex,
    rect: new Vector4(x0, y0, 1 / span, 1 / span),
    texel,
    norm: 1 / Math.max(avgPerTexel, 1e-6),
    maxLod: mipmaps.length - 1,
  };
}

// Tileable 3D value-noise fbm
function buildNoise(size = 64) {
  const hash = (x: number, y: number, z: number, p: number) => {
    x = ((x % p) + p) % p; y = ((y % p) + p) % p; z = ((z % p) + p) % p;
    let h = (x * 374761393 + y * 668265263 + z * 1274126177) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  };
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const noise = (x: number, y: number, z: number, p: number) => {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const u = smooth(x - xi), v = smooth(y - yi), w = smooth(z - zi);
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
    const c = (dx: number, dy: number, dz: number) => hash(xi + dx, yi + dy, zi + dz, p);
    return lerp(
      lerp(lerp(c(0, 0, 0), c(1, 0, 0), u), lerp(c(0, 1, 0), c(1, 1, 0), u), v),
      lerp(lerp(c(0, 0, 1), c(1, 0, 1), u), lerp(c(0, 1, 1), c(1, 1, 1), u), v),
      w,
    );
  };
  const data = new Uint8Array(size * size * size);
  const octaves = [ [4, 0.5], [8, 0.25], [16, 0.15], [32, 0.1] ];
  for (let z = 0; z < size; z++)
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        let n = 0;
        for (const [p, a] of octaves) {
          const s = p / size;
          n += a * noise(x * s, y * s, z * s, p);
        }
        data[(z * size + y) * size + x] = Math.round(Math.min(Math.max(n, 0), 1) * 255);
      }
  const tex = new Data3DTexture(data, size, size, size);
  tex.format = RedFormat;
  tex.type = UnsignedByteType;
  tex.minFilter = tex.magFilter = LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = RepeatWrapping;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

class LitCloudsRawEffect extends PPEffect {
  private readonly camera: PerspectiveCamera;
  private readonly frame: LocalFrame;
  private time = 0;
  private windOffset = new Vector2();
  private readonly tmp = new Matrix3();
  private readonly tmp4 = new Matrix4();
  wind = 0;

  constructor(camera: PerspectiveCamera, frame: LocalFrame, params: LitCloudsParams, lightColor: number) {
    super("LitCloudsEffect", FRAG, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map<string, Uniform>([
        ["uDepth", new Uniform(null)],
        ["uDepthPacked", new Uniform(1)],
        ["uLampMap", new Uniform(null)],
        ["uNoise", new Uniform(buildNoise())],
        ["uInvProj", new Uniform(new Matrix4())],
        ["uViewToLocal", new Uniform(new Matrix3())],
        ["uCamLocal", new Uniform(new Vector3())],
        ["uFar", new Uniform(camera.far)],
        ["uMapRect", new Uniform(new Vector4(0, 0, 0, 0))],
        ["uMapTexel", new Uniform(1)],
        ["uMapNorm", new Uniform(0)],
        ["uMapMaxLod", new Uniform(0)],
        ["uBase", new Uniform(0)],
        ["uThick", new Uniform(0)],
        ["uCoverage", new Uniform(0)],
        ["uDensity", new Uniform(0)],
        ["uDetail", new Uniform(0)],
        ["uScale", new Uniform(1)],
        ["uStretch", new Uniform(1)],
        ["uWindOffset", new Uniform(new Vector2())],
        ["uGlow", new Uniform(0)],
        ["uFalloff", new Uniform(1)],
        ["uSkyGlow", new Uniform(0)],
        ["uOpacity", new Uniform(1)],
        ["uLightColor", new Uniform(new Color(lightColor))],
        ["uTime", new Uniform(0)],
        ["uMaxDist", new Uniform(8000)],
      ]),
    });
    this.camera = camera;
    this.frame = frame;
    this.setParams(params);
  }

  private set(name: string, value: unknown) {
    this.uniforms.get(name)!.value = value;
  }

  setParams(p: Partial<LitCloudsParams>) {
    if (p.coverage !== undefined) this.set("uCoverage", p.coverage);
    if (p.base !== undefined) this.set("uBase", p.base);
    if (p.thickness !== undefined) this.set("uThick", p.thickness);
    if (p.density !== undefined) this.set("uDensity", p.density);
    if (p.detail !== undefined) this.set("uDetail", p.detail);
    if (p.scale !== undefined) this.set("uScale", p.scale);
    if (p.stretch !== undefined) this.set("uStretch", p.stretch);
    if (p.wind !== undefined) this.wind = p.wind;
    if (p.glow !== undefined) this.set("uGlow", p.glow);
    if (p.falloff !== undefined) this.set("uFalloff", p.falloff);
    if (p.skyGlow !== undefined) this.set("uSkyGlow", p.skyGlow);
    if (p.opacity !== undefined) this.set("uOpacity", p.opacity);
  }

  setLightColor(hex: number) {
    (this.uniforms.get("uLightColor")!.value as Color).set(hex);
  }

  setLamps(ecef: { x: number; y: number; z: number }[]) {
    const map = buildLampMap(ecef.map((p) => this.frame.toLocal(p)));
    (this.uniforms.get("uLampMap")!.value as Texture | null)?.dispose();
    this.set("uLampMap", map.tex);
    this.set("uMapRect", map.rect);
    this.set("uMapTexel", map.texel);
    this.set("uMapNorm", map.norm);
    this.set("uMapMaxLod", map.maxLod);
  }

  setDepth(tex: Texture | undefined, packing: number | undefined) {
    this.set("uDepth", tex ?? null);
    this.set("uDepthPacked", packing === 3201 ? 1 : 0);
  }

  update(_renderer: WebGLRenderer, _input: WebGLRenderTarget, deltaTime?: number) {
    const dt = deltaTime ?? 0;
    this.time += dt;
    this.windOffset.x += this.wind * dt;
    this.set("uTime", this.time % 1000);
    (this.uniforms.get("uWindOffset")!.value as Vector2).copy(this.windOffset);

    const cam = this.camera;
    cam.updateMatrixWorld();
    (this.uniforms.get("uInvProj")!.value as Matrix4).copy(cam.projectionMatrixInverse);
    this.set("uFar", cam.far);
    this.tmp4.extractRotation(cam.matrixWorld);
    (this.uniforms.get("uViewToLocal")!.value as Matrix3)
      .copy(this.frame.ecefToLocal)
      .multiply(this.tmp.setFromMatrix4(this.tmp4));
    (this.uniforms.get("uCamLocal")!.value as Vector3).copy(
      this.frame.toLocal(new Vector3().setFromMatrixPosition(cam.matrixWorld)),
    );
  }
}

class LitClouds extends Effect<LitCloudsRawEffect> {}

export type LitCloudsConfig = EffectConfig & {
  litClouds?: {
    frame: LocalFrame;
    params: LitCloudsParams;
    lightColor: number;
  };
};
export type LitCloudsUpdate = EffectUpdate & {
  litClouds?: {
    params?: Partial<LitCloudsParams>;
    lightColor?: number;
    lamps?: { x: number; y: number; z: number }[];
  };
};

export class LitCloudsEffectDesc extends EffectDesc<LitCloudsConfig, LitCloudsUpdate, LitClouds> {
  static key = "litClouds";
  static insertBefore = ["transparent"];
  private readonly config: LitCloudsConfig;
  private effect?: LitCloudsRawEffect;

  constructor(view: ThreeView, ctx: ViewContext, config: LitCloudsConfig) {
    super(view, ctx, config);
    this.config = config;
  }

  createPass() {
    const { frame, params, lightColor } = this.config.litClouds!;
    const camera = this.view.camera.raw as PerspectiveCamera;
    this.effect = new LitCloudsRawEffect(camera, frame, params, lightColor);
    return new LitClouds(camera, this.effect, { enabled: this.config.visible ?? true });
  }

  update(_time: number) {
    const mrt = this.find("mrt") as unknown as
      | { depthBuffer?: Texture; depthBufferPacking?: number }
      | undefined;
    this.effect?.setDepth(mrt?.depthBuffer, mrt?.depthBufferPacking);
  }

  onUpdateConfig(updates: LitCloudsUpdate) {
    super.onUpdateConfig(updates);
    const u = updates.litClouds;
    if (!u || !this.effect) return;
    if (u.params) this.effect.setParams(u.params);
    if (u.lightColor !== undefined) this.effect.setLightColor(u.lightColor);
    if (u.lamps) this.effect.setLamps(u.lamps);
  }
}
