// OSM street names painted along the streets in URW Classico (Optima). Navara text is
// point-anchored (no MapLibre symbol-placement: line), so labels are laid out
// here: either one straight block per label, or curved, with each letter its
// own anchor placed along the street and turned to the local tangent.
import type ThreeView from "@navaramap/three";
import {
  Color,
  Plugin,
  type FeatureEvaluator,
  type Layer,
  type Source,
  type ViewContext,
} from "@navaramap/three";
import { Color as ThreeColor, Mesh, type ShaderMaterial } from "three";

// Advance widths (em) per face, from scripts/build_fonts.py
import metrics from "./fontMetrics.json";
// Named OSM streets merged into chains, from scripts/build_streets.py;
// rank 5 freeway .. 1 residential
import streets from "./streets.json";

export type LabelWeight = "regular" | "bold" | "italic" | "bolditalic";

export type LabelParams = {
  show: boolean;
  size: number; // metres
  repeat: number; // metres between labels of the same street
  lift: number; // metres above the bare-earth terrain
  opacity: number;
  outline: number; // px
  outlineOpacity: number;
  glow: number; // 1 = picker colour after tone mapping
  color: string;
  outlineColor: string;
  weight: LabelWeight;
  facing: "flat" | "upright";
  upper: boolean;
  abbreviate: boolean;
  curved: boolean;
  tracking: number; // em added between letters
  minRank: number;
  declutter: boolean;
};

// Absolute URL: Navara's font worker resolves against its own location
const fontUrl = (w: LabelWeight) =>
  new URL(`${import.meta.env.BASE_URL}fonts/classico-${w}.ttf`, location.href).href;

// The built faces carry a 0.02 em hair space for straight labels
const HAIR_SPACE = " ";
const HAIR_EM = 0.02;
const track = (text: string, em: number) => {
  const n = Math.round(em / HAIR_EM);
  return n > 0 ? [...text].join(HAIR_SPACE.repeat(n)) : text;
};

// USPS street suffixes, plus leading directionals
const SUFFIX: Record<string, string> = {
  Alley: "Aly", Avenue: "Ave", Boulevard: "Blvd", Circle: "Cir", Court: "Ct",
  Crescent: "Cres", Drive: "Dr", Freeway: "Fwy", Highway: "Hwy", Lane: "Ln",
  Parkway: "Pkwy", Place: "Pl", Road: "Rd", Square: "Sq", Street: "St",
  Terrace: "Ter", Trail: "Trl",
};
const DIRECTION: Record<string, string> = { North: "N", South: "S", East: "E", West: "W" };
const abbreviate = (name: string) => {
  const words = name.split(" ");
  if (words.length > 1 && DIRECTION[words[0]]) words[0] = DIRECTION[words[0]];
  const last = words.length - 1;
  if (last > 0 && SUFFIX[words[last]]) words[last] = SUFFIX[words[last]];
  return words.join(" ");
};

const M_PER_LAT = 111320;
const M_PER_LNG = 111320 * Math.cos((34.09 * Math.PI) / 180);
const HEIGHT_STEP = 10; // m between terrain samples along each chain
// Reject a spot that kinks between letters or wraps a hairpin into a C/Z
const MAX_BEND = 35; // deg between neighbouring letters
const MAX_TOTAL_BEND = 80; // deg over the whole label

type Chain = {
  name: string;
  rank: number;
  x: Float64Array; // metres, equirectangular about Silver Lake
  y: Float64Array;
  cum: Float64Array; // arc length at each vertex
  length: number;
  heights?: Float32Array; // every HEIGHT_STEP m
};

const chains: Chain[] = (streets as { n: string; r: number; c: [number, number][] }[]).map((s) => {
  const x = new Float64Array(s.c.length), y = new Float64Array(s.c.length), cum = new Float64Array(s.c.length);
  s.c.forEach(([lng, lat], i) => {
    x[i] = lng * M_PER_LNG;
    y[i] = lat * M_PER_LAT;
    if (i) cum[i] = cum[i - 1] + Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1]);
  });
  return { name: s.n, rank: s.r, x, y, cum, length: cum[cum.length - 1] };
});

function pointAt(c: Chain, s: number) {
  s = Math.min(Math.max(s, 0), c.length);
  let lo = 0, hi = c.cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (c.cum[mid] <= s) lo = mid;
    else hi = mid;
  }
  const seg = c.cum[hi] - c.cum[lo];
  const t = seg > 0 ? (s - c.cum[lo]) / seg : 0;
  return { x: c.x[lo] + (c.x[hi] - c.x[lo]) * t, y: c.y[lo] + (c.y[hi] - c.y[lo]) * t };
}

function heightAt(c: Chain, s: number) {
  const h = c.heights;
  if (!h) return 100;
  const f = Math.min(Math.max(s / HEIGHT_STEP, 0), h.length - 1);
  const i = Math.floor(f), j = Math.min(i + 1, h.length - 1);
  return h[i] + (h[j] - h[i]) * (f - i);
}

// Direction a->b in degrees counter-clockwise from east
const angleOf = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
const wrap = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

type Glyph = { x: number; y: number; text: string; rot: number; h: number; rank: number };

// Lay one label out centred at arc length `sc`; null if it doesn't fit there
function layout(c: Chain, sc: number, text: string, p: LabelParams): Glyph[] | null {
  const widths = metrics[p.weight] as Record<string, number>;
  const chars = [...text];
  const adv = chars.map((ch) => (widths[ch] ?? 0.6) * p.size);
  const gap = p.tracking * p.size;
  const L = adv.reduce((a, b) => a + b, 0) + gap * (chars.length - 1);
  if (sc - L / 2 < 0 || sc + L / 2 > c.length) return null;

  // Read left to right: run along the chain or against it
  let span = angleOf(pointAt(c, sc - L / 2), pointAt(c, sc + L / 2));
  const dir = span > 90 || span < -90 ? -1 : 1;
  if (dir < 0) span = wrap(span + 180);

  if (!p.curved || p.facing === "upright") {
    const at = pointAt(c, sc);
    return [{ ...at, text: track(text, p.tracking), rot: -span, h: heightAt(c, sc), rank: c.rank }];
  }

  const out: Glyph[] = [];
  const reach = Math.max(p.size * 0.6, 3);
  let cursor = 0;
  let prev: number | undefined;
  let turned = 0;
  for (let i = 0; i < chars.length; i++) {
    const s = sc + dir * (cursor + adv[i] / 2 - L / 2);
    cursor += adv[i] + gap;
    const angle = angleOf(pointAt(c, s - dir * reach), pointAt(c, s + dir * reach));
    if (prev !== undefined) {
      const bend = Math.abs(wrap(angle - prev));
      turned += bend;
      if (bend > MAX_BEND || turned > MAX_TOTAL_BEND) return null;
    }
    prev = angle;
    if (chars[i] === " ") continue;
    out.push({ ...pointAt(c, s), text: chars[i], rot: -angle, h: heightAt(c, s), rank: c.rank });
  }
  return out;
}

function place(p: LabelParams): { glyphs: Glyph[]; labels: number } {
  const placed = new Map<string, { x: number; y: number }[]>();
  const glyphs: Glyph[] = [];
  let labels = 0;
  for (const c of chains) {
    if (c.rank < p.minRank) continue;
    let text = p.abbreviate ? abbreviate(c.name) : c.name;
    if (p.upper) text = text.toUpperCase();
    // OSM can split a street into several chains; space same-name labels globally
    const mine = placed.get(c.name) ?? [];
    placed.set(c.name, mine);
    const n = Math.max(1, Math.floor(c.length / p.repeat));
    for (let k = 0; k < n; k++) {
      const centre = (c.length / n) * (k + 0.5);
      // Nudge off sharp bends before giving up on this spot
      for (const shift of [0, 0.15, -0.15, 0.3, -0.3]) {
        const sc = centre + shift * Math.min(p.repeat, c.length);
        const at = pointAt(c, sc);
        if (mine.some((m) => Math.hypot(m.x - at.x, m.y - at.y) < p.repeat * 0.8)) break;
        const g = layout(c, sc, text, p);
        if (!g) continue;
        mine.push(at);
        glyphs.push(...g);
        labels++;
        break;
      }
    }
  }
  return { glyphs, labels };
}

export class StreetLabels {
  private readonly view: ThreeView;
  private readonly terrain: Source;
  private readonly params: LabelParams;
  private source?: Source;
  private layer?: Layer;
  private timer?: number;
  exposure = 1;
  onStatus?: (labels: number) => void;

  constructor(view: ThreeView, terrain: Source, params: LabelParams) {
    this.view = view;
    this.terrain = terrain;
    this.params = params;
  }

  // Sample bare-earth heights along every chain once; layout reuses them
  async init() {
    const pts: { lng: number; lat: number }[] = [];
    for (const c of chains) {
      const n = Math.floor(c.length / HEIGHT_STEP) + 1;
      for (let k = 0; k < n; k++) {
        const { x, y } = pointAt(c, k * HEIGHT_STEP);
        pts.push({ lng: x / M_PER_LNG, lat: y / M_PER_LAT });
      }
    }
    const samples = await this.view.sampleTerrainMostDetailed(this.terrain, pts);
    let i = 0;
    for (const c of chains) {
      const n = Math.floor(c.length / HEIGHT_STEP) + 1;
      c.heights = Float32Array.from({ length: n }, () => samples[i++].height ?? 100);
    }
    this.relayout();
  }

  // Labels draw in HDR before tone mapping; divide out exposure so the
  // picker colour is roughly what lands on screen
  private hdr(style: string) {
    const c = new ThreeColor().setStyle(style);
    const k = this.params.glow / Math.max(this.exposure, 1e-3);
    return new Color().setRGBLinear(c.r * k, c.g * k, c.b * k);
  }

  // Passing `font` to layer.update() blanks the layer, so it's only set at
  // creation and a weight change rebuilds the layer
  private material() {
    const p = this.params;
    const curved = p.curved && p.facing === "flat";
    return {
      size: p.size,
      sizeInMeters: true,
      color: this.hdr(p.color),
      outlineColor: this.hdr(p.outlineColor),
      outlineWidth: p.outline,
      outlineOpacity: p.outlineOpacity,
      opacity: p.opacity,
      textFacing: p.facing,
      rotateWithCamera: p.facing === "upright",
      // Per-letter anchors would declutter into broken words
      declutter: p.declutter && !curved,
      highQuality: true,
      show: p.show,
    };
  }

  private createLayer() {
    if (this.layer) this.view.deleteLayerById(this.layer.id);
    this.layer = this.view.addLayer({
      type: "vector",
      source: this.source!,
      text: { ...this.material(), font: fontUrl(this.params.weight) },
    });
    const evaluate = ({ evaluator }: { evaluator: FeatureEvaluator }) =>
      evaluator.evaluate(({ properties }) => ({
        text: String(properties?.["t"] ?? ""),
        rotation: this.params.facing === "flat" ? Number(properties?.["rot"] ?? 0) : 0,
        height: Number(properties?.["h"] ?? 100) + this.params.lift,
        declutterPriority: Number(properties?.["rank"] ?? 0),
      }));
    this.layer.on("featureCreated", evaluate);
    this.layer.on("featureUpdated", evaluate);
  }

  // Re-run placement (text, size, spacing, curve, road class); debounced for sliders
  relayout() {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      const { glyphs, labels } = place(this.params);
      const data = {
        type: "FeatureCollection" as const,
        features: glyphs.map((g) => ({
          type: "Feature" as const,
          geometry: { type: "Point" as const, coordinates: [g.x / M_PER_LNG, g.y / M_PER_LAT] },
          properties: { t: g.text, rot: g.rot, h: g.h, rank: g.rank },
        })),
      };
      if (!this.source) {
        this.source = this.view.addSource({ type: "geojson", data });
        this.createLayer();
      } else {
        this.source.update({ type: "geojson", data });
      }
      this.onStatus?.(labels);
    }, 120);
  }

  // Material-level changes (colours, opacity, halo, facing, declutter, show)
  restyle() {
    this.layer?.update({ type: "vector", text: this.material() });
    this.layer?.forceUpdate();
  }

  // Font weight: new metrics, new layer
  reweight() {
    if (this.source) this.createLayer();
    this.relayout();
  }

  // Per-feature changes that don't move anchors (lift)
  reevaluate() {
    this.layer?.forceUpdate();
  }
}

// Navara puts text in the G-buffer (MRT) pass whenever an effect needs
// normals, so the night-ambient composite in nightFogLight would black it out
// and lamps would light it like pavement. Draw each text mesh through a proxy
// in the transparent pass instead, which runs after fog and clouds.
export class LabelsAfterFogPlugin extends Plugin<ThreeView, ViewContext> {
  async init(view: ThreeView, ctx: ViewContext) {
    const proxies = new Map<Mesh, Mesh>();
    view.on("preRender", () => {
      const seen = new Set<Mesh>();
      ctx.scenes.mrt.traverse((o) => {
        const m = o as Mesh;
        if (!m.isMesh || !(m.material as ShaderMaterial).uniforms?.uSdfThreshold) return;
        seen.add(m);
        let p = proxies.get(m);
        if (!p) {
          p = new Mesh();
          p.matrixAutoUpdate = false;
          m.layers.disableAll();
          ctx.scenes.transparent.add(p);
          proxies.set(m, p);
        }
        p.geometry = m.geometry;
        p.material = m.material;
        p.visible = m.visible;
        p.frustumCulled = m.frustumCulled;
        p.renderOrder = m.renderOrder;
        p.matrix.copy(m.matrixWorld);
        p.matrixWorldNeedsUpdate = true;
      });
      for (const [m, p] of proxies)
        if (!seen.has(m)) {
          p.removeFromParent();
          proxies.delete(m);
        }
    });
  }
}
