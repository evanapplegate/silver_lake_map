import ThreeView, { Color, geodeticToVector3 } from "@navaramap/three";
import type {
  AmbientLightDesc,
  FogLightDefinition,
  FogLightEffectDesc,
  RainMeshDesc,
} from "@navaramap/three-default-descs";
import {
  DefaultPlugin,
  type DefaultDescriptions,
} from "@navaramap/three-default-plugin";
import { ToneMappingMode } from "postprocessing";

import {
  LitCloudsEffectDesc,
  LocalFrame,
  type LitCloudsConfig,
  type LitCloudsParams,
} from "./litClouds";
import { kelvinToHex, lightSceneWithLamps } from "./nightFogLight";
import { RainSound } from "./rainSound";
import {
  LabelsAfterFogPlugin,
  StreetLabels,
  type LabelParams,
  type LabelWeight,
} from "./streetLabels";
// City of LA Bureau of Street Lighting poles, Silver Lake bbox [lng, lat]
import lampLngLat from "./lamps.json";

// Injected at build time (.env.local locally, a repo secret in CI); never
// in source or URLs. It's still visible in the shipped JS, so the key itself
// must be restricted by referrer and API in Google Cloud.
const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;

// LA cobra-head poles are ~30 ft
const LAMP_HEIGHT = 9;

const params = {
  // Unlit share of the baked-daylight tiles; lamps light the full albedo
  ambient: 0,
  // 2000K blackbody, low-pressure sodium look
  kelvin: 2000,
  color: kelvinToHex(2000),
  fogDensity: 0.05,
  intensity: 1.5,
  radius: 225,
  halo: 1,
  exposure: 12,
  rainCount: 30000,
  rainOpacity: 1,
  rainSpeed: 0.0015,
  rainLength: 5,
  rainWidth: 2,
  // Rain is a lit mesh drawn after the fog pass; this ambient is its only
  // light at night, tinted sodium so the streaks read as lamp-lit
  rainLight: 0.2,
  clouds: true,
  // Low wispy layer lit from below by the lamps. Heights are metres above
  // the ellipsoid; Silver Lake streets sit ~80-170 m, the camera at 360 m.
  cloud: {
    coverage: 0.5,
    base: 50,
    thickness: 180,
    density: 0.0035,
    detail: 1,
    scale: 400,
    stretch: 1,
    wind: 3,
    glow: 0.25,
    falloff: 440,
    skyGlow: 0.015,
    opacity: 1,
  } satisfies LitCloudsParams,
  starIntensity: 20,
  starSize: 1,
  labels: {
    show: true,
    size: 4.5,
    repeat: 725,
    lift: 0,
    opacity: 0.1,
    outline: 2.75,
    outlineOpacity: 0.8,
    glow: 1,
    color: "#ff890e",
    outlineColor: "#140d07",
    weight: "regular",
    facing: "flat",
    upper: true,
    abbreviate: true,
    curved: true,
    tracking: 0.34,
    minRank: 1,
    declutter: true,
  } satisfies LabelParams as LabelParams,
};

const view = new ThreeView<DefaultDescriptions>({
  container: document.getElementById("main")!,
  animation: true,
  // No on-map credits button; data sources are listed in README.md
  defaultAttribution: false,
});

const defaultPlugin = new DefaultPlugin();
view.addPlugin(defaultPlugin);
view.addPlugin(new LabelsAfterFogPlugin());

await view.init();

const scene = defaultPlugin.addDefaultPhotorealScene();
// AgX (default) washes saturated sodium out to peach; ACES keeps the amber
scene.toneMapping.update({
  toneMapping: { mode: ToneMappingMode.ACES_FILMIC },
});
view.toneMappingExposure = params.exposure;
const ambient = view.addLight<AmbientLightDesc>({
  ambient: { color: new Color().setHex(params.color), intensity: params.rainLight },
});
// 10pm PST
view.atmosphere.date = new Date("2026-11-06T06:00:00Z");

// South-west of Sunset Junction, looking NE over the reservoir
view.setCamera({
  lng: -118.2795,
  lat: 34.0812,
  height: 360,
  heading: 38,
  pitch: -11,
  roll: 0,
});
view.camera.fov = 45;

// Bare-earth ellipsoidal heights for lamp bases
const terrain = view.addSource({
  type: "quantized-mesh",
  url: "https://terrain.reearth.land/cesium-mesh/ellipsoid/{z}/{x}/{y}.terrain",
  maxZoom: 14,
  requestVertexNormals: true,
});

let tiles: ReturnType<typeof view.addLayer> | undefined;
if (GOOGLE_MAPS_API_KEY) {
  const tilesSource = view.addSource({
    type: "3d-tiles",
    url: `https://tile.googleapis.com/v1/3dtiles/root.json?key=${encodeURIComponent(
      GOOGLE_MAPS_API_KEY,
    )}`,
  });
  tiles = view.addLayer({
    type: "3d-tiles",
    source: tilesSource,
    model: { maxSse: 16, normals: true },
  });
} else {
  // No key: grey terrain stand-in so the lighting can still be judged
  view.addLayer({ type: "terrain", source: terrain });
  document.body.insertAdjacentHTML(
    "beforeend",
    `<div id="nokey">No Google key: set VITE_GOOGLE_MAPS_API_KEY in .env.local and restart</div>`,
  );
}

const lampDefs = (heights: (number | undefined)[]): FogLightDefinition[] =>
  (lampLngLat as [number, number][]).map(([lng, lat], i) => {
    const { x, y, z } = geodeticToVector3({
      lng,
      lat,
      height: (heights[i] ?? 100) + LAMP_HEIGHT,
    });
    return {
      position: { x, y, z },
      color: params.color,
      intensity: params.intensity,
      radius: params.radius,
    };
  });

let lamps = lampDefs([]);

const fogLight = view.addEffect<FogLightEffectDesc>({
  fogLight: {
    lights: lamps,
    fogDensity: params.fogDensity,
    useSurfaceLighting: true,
    maxFar: 6000,
    haloFalloff: params.halo,
    // Full-res so each lamp core stays pole-sized instead of a 4px smear
    downsample: 1,
    // Default 64 overflows with ~2.9k dense lamps and shows tile blocks
    maxLightsPerTile: 256,
  },
});
const setAmbient = lightSceneWithLamps(fogLight, params.ambient);
scene.stars.update({
  stars: { intensity: params.starIntensity, pointSize: params.starSize },
});

const labels = new StreetLabels(view, terrain, params.labels);
labels.exposure = params.exposure;
labels.init();

const status = document.getElementById("status")!;
status.textContent = `${lamps.length} lamps, sampling terrain…`;
view
  .sampleTerrainMostDetailed(
    terrain,
    (lampLngLat as [number, number][]).map(([lng, lat]) => ({ lng, lat })),
  )
  .then((samples) => {
    lamps = lampDefs(samples.map((s) => s.height));
    fogLight.update({ fogLight: { lights: lamps } });
    clouds.update({ litClouds: { lamps: lamps.map((l) => l.position) } });
    status.textContent = `${lamps.length} LA BSL streetlights`;
  })
  .catch((err) => {
    console.error(err);
    status.textContent = `${lamps.length} lamps (terrain sample failed)`;
  });

const rain = view.addMesh<RainMeshDesc>({
  rain: {
    particleCount: params.rainCount,
    opacity: params.rainOpacity,
    speed: params.rainSpeed,
    height: params.rainLength,
    width: params.rainWidth,
  },
});

view.registerEffect("litClouds", LitCloudsEffectDesc);
const cloudsConfig: LitCloudsConfig = {
  litClouds: {
    frame: new LocalFrame(34.09, -118.27),
    params: params.cloud,
    lightColor: params.color,
  },
};
const clouds = view.addEffect<LitCloudsEffectDesc>(cloudsConfig);
clouds.update({ litClouds: { lamps: lamps.map((l) => l.position) } });

// UI
const panel = document.getElementById("panel")!;
panel.hidden = false;
// Collapsed, the panel shrinks to a faint caret so it stays out of screen caps
const setCollapsed = (collapsed: boolean) => {
  document.body.classList.toggle("panel-collapsed", collapsed);
  try {
    localStorage.setItem("panel-collapsed", collapsed ? "1" : "0");
  } catch {}
};
try {
  setCollapsed(localStorage.getItem("panel-collapsed") === "1");
} catch {}
panel.querySelector("h1")!.onclick = () => setCollapsed(true);

const sound = new RainSound(`${import.meta.env.BASE_URL}audio/rain.m4a`);
// Fetch once the scene has had its turn at the network
setTimeout(() => sound.prefetch(), 4000);
const soundBtn = document.getElementById("sound")!;
soundBtn.onclick = () => {
  const on = !sound.playing;
  soundBtn.setAttribute("aria-pressed", String(on));
  if (on) sound.play();
  else sound.stop();
};
document.getElementById("caret")!.onclick = () => setCollapsed(false);
const bind = (
  id: string,
  value: number,
  onInput: (v: number) => void,
) => {
  const input = document.getElementById(id) as HTMLInputElement;
  const out = input.nextElementSibling as HTMLSpanElement;
  // Filled part of the hairline track
  const fill = () => {
    const min = Number(input.min), max = Number(input.max);
    input.style.setProperty("--pct", `${((Number(input.value) - min) / (max - min)) * 100}%`);
  };
  input.value = String(value);
  out.textContent = String(value);
  fill();
  input.oninput = () => {
    const v = Number(input.value);
    out.textContent = String(v);
    fill();
    onInput(v);
  };
};
const bindValue = (id: string, value: string, onInput: (v: string) => void) => {
  const input = document.getElementById(id) as HTMLInputElement | HTMLSelectElement;
  input.value = value;
  input.oninput = () => onInput(input.value);
};
const bindToggle = (id: string, label: string, value: boolean, onToggle: (v: boolean) => void) => {
  const btn = document.getElementById(id)!;
  const render = () => (btn.textContent = `${label} ${value ? "on" : "off"}`);
  render();
  btn.onclick = () => {
    value = !value;
    render();
    onToggle(value);
  };
};
const relight = () => {
  lamps = lamps.map((l) => ({
    ...l,
    color: params.color,
    intensity: params.intensity,
    radius: params.radius,
  }));
  fogLight.update({ fogLight: { lights: lamps } });
};
const colorInput = document.getElementById("lightColor") as HTMLInputElement;
const setLightColor = (hex: number) => {
  params.color = hex;
  relight();
  clouds.update({ litClouds: { lightColor: hex } });
  ambient.update({ ambient: { color: new Color().setHex(hex) } });
  colorInput.value = `#${hex.toString(16).padStart(6, "0")}`;
};
colorInput.value = `#${params.color.toString(16).padStart(6, "0")}`;
colorInput.oninput = () => setLightColor(parseInt(colorInput.value.slice(1), 16));
bind("kelvin", params.kelvin, (v) => {
  params.kelvin = v;
  setLightColor(kelvinToHex(v));
});
bind("ambient", params.ambient, (v) => {
  params.ambient = v;
  setAmbient(v);
});
bind("fog", params.fogDensity, (v) => {
  params.fogDensity = v;
  fogLight.update({ fogLight: { fogDensity: v } });
});
bind("intensity", params.intensity, (v) => {
  params.intensity = v;
  relight();
});
bind("radius", params.radius, (v) => {
  params.radius = v;
  relight();
});
bind("halo", params.halo, (v) => {
  params.halo = v;
  fogLight.update({ fogLight: { haloFalloff: v } });
});
bind("exposure", params.exposure, (v) => {
  params.exposure = v;
  view.toneMappingExposure = v;
  labels.exposure = v;
  labels.restyle();
});
for (const key of Object.keys(params.cloud) as (keyof LitCloudsParams)[]) {
  bind(`cloud-${key}`, params.cloud[key], (v) => {
    params.cloud[key] = v;
    clouds.update({ litClouds: { params: { [key]: v } } });
  });
}
bind("starIntensity", params.starIntensity, (v) => {
  scene.stars.update({ stars: { intensity: v } });
});
bind("starSize", params.starSize, (v) => {
  scene.stars.update({ stars: { pointSize: v } });
});
bind("rainCount", params.rainCount, (v) => {
  rain.update({ rain: { particleCount: v } });
});
bind("rainOpacity", params.rainOpacity, (v) => {
  rain.update({ rain: { opacity: v } });
});
bind("rainSpeed", params.rainSpeed, (v) => {
  rain.update({ rain: { speed: v } });
});
bind("rainLength", params.rainLength, (v) => {
  rain.update({ rain: { height: v } });
});
bind("rainWidth", params.rainWidth, (v) => {
  rain.update({ rain: { width: v } });
});
bind("rainLight", params.rainLight, (v) => {
  ambient.update({ ambient: { intensity: v } });
});

const lp = params.labels;
bind("label-size", lp.size, (v) => ((lp.size = v), labels.restyle(), labels.relayout()));
bind("label-repeat", lp.repeat, (v) => ((lp.repeat = v), labels.relayout()));
bind("label-lift", lp.lift, (v) => ((lp.lift = v), labels.reevaluate()));
bind("label-opacity", lp.opacity, (v) => ((lp.opacity = v), labels.restyle()));
bind("label-outline", lp.outline, (v) => ((lp.outline = v), labels.restyle()));
bind("label-outlineOpacity", lp.outlineOpacity, (v) => ((lp.outlineOpacity = v), labels.restyle()));
bind("label-tracking", lp.tracking, (v) => ((lp.tracking = v), labels.relayout()));
bind("label-glow", lp.glow, (v) => ((lp.glow = v), labels.restyle()));
bindValue("label-color", lp.color, (v) => ((lp.color = v), labels.restyle()));
bindValue("label-outlineColor", lp.outlineColor, (v) => ((lp.outlineColor = v), labels.restyle()));
bindValue("label-weight", lp.weight, (v) => ((lp.weight = v as LabelWeight), labels.reweight()));
bindValue("label-facing", lp.facing, (v) => {
  lp.facing = v as LabelParams["facing"];
  labels.restyle();
  labels.relayout();
});
bindValue("label-minRank", String(lp.minRank), (v) => ((lp.minRank = Number(v)), labels.relayout()));
bindToggle("label-show", "Labels", lp.show, (v) => ((lp.show = v), labels.restyle()));
bindToggle("label-upper", "Caps", lp.upper, (v) => ((lp.upper = v), labels.relayout()));
bindToggle("label-abbreviate", "Abbrev", lp.abbreviate, (v) => ((lp.abbreviate = v), labels.relayout()));
bindToggle("label-curved", "Curved", lp.curved, (v) => {
  lp.curved = v;
  labels.restyle();
  labels.relayout();
});
bindToggle("label-declutter", "Declutter", lp.declutter, (v) => ((lp.declutter = v), labels.restyle()));

bindToggle("clouds", "Clouds", params.clouds, (v) => {
  params.clouds = v;
  clouds.update({ visible: v });
});
bindToggle("rain", "Rain", true, (v) => {
  rain.visible = v;
});

Object.assign(window, { view, scene, fogLight, rain, clouds, tiles, labels, sound });
