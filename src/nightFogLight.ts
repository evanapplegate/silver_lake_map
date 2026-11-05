import type { EffectHandle } from "@navaramap/three";
import type { FogLightEffectDesc } from "@navaramap/three-default-descs";
import { Uniform } from "three";

// FogLight lights surfaces with the incoming color as albedo and adds the
// result on top of it. Google tiles carry baked daylight, so darkening them
// first also starves the lamp light. Patch the final composite instead: keep
// the full albedo for the lamp term, scale only the unlit base by `ambient`.
// Sky pixels (at the far plane) are left alone so stars survive; distant
// terrain has perspective depth ~1 too, so test view distance instead.
//
// It also rebuilds each pixel's world position in ECEF (~6.4e6 m), where
// float32 only resolves ~0.5 m, so close-up halos break into blocks. Take
// the view ray from camera-relative view space instead.
const TARGET = "vec3 finalColor = inputColor.rgb + fogColor;";
const PATCHES: [string, string][] = [
  ["uniform float fogDensity;", "uniform float fogDensity;\nuniform float nightAmbient;"],
  [TARGET, "vec3 finalColor = inputColor.rgb * (-viewZ < cameraFar * 0.9 ? nightAmbient : 1.0) + fogColor;"],
  ["vec3 viewRay = worldPos - cameraPos;", "vec3 viewRay = mat3(invViewMatrix) * viewPos;"],
  ["vec3 L = lightPos - worldPos;", "vec3 L = camToLight - viewDir * viewDist;"],
];

type PatchableEffect = {
  uniforms: Map<string, Uniform>;
  getFragmentShader(): string;
  setFragmentShader(src: string): void;
};

export function lightSceneWithLamps(
  handle: EffectHandle<FogLightEffectDesc>,
  ambient: number,
): (ambient: number) => void {
  const effect = handle.ref.raw?.rawEffect as unknown as PatchableEffect | undefined;
  if (!effect) throw new Error("FogLight effect not created yet");
  let src = effect.getFragmentShader();
  for (const [from, to] of PATCHES) {
    if (!src.includes(from)) throw new Error(`FogLight shader changed; missing "${from}"`);
    src = src.replace(from, to);
  }
  effect.uniforms.set("nightAmbient", new Uniform(ambient));
  effect.setFragmentShader(src);
  return (v) => {
    effect.uniforms.get("nightAmbient")!.value = v;
  };
}

// Tanner Helland's blackbody fit, 1000-40000 K
export function kelvinToHex(kelvin: number): number {
  const t = kelvin / 100;
  const clamp = (v: number) => Math.round(Math.min(255, Math.max(0, v)));
  let r: number, g: number, b: number;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  return (clamp(r) << 16) | (clamp(g) << 8) | clamp(b);
}
