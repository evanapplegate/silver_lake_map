# Learnings

Running notes from building the Silver Lake night scene on Navara
(`@navaramap/three` 0.2.1, three 0.187, postprocessing 6.39). Newest at the
bottom of each section.

## Setup

- Vite: exclude `@navaramap/*` from `optimizeDeps`. Navara resolves its wasm,
  workers and atmosphere textures via `import.meta.url`, which pre-bundling
  breaks.
- The Navara example sources aren't on GitHub pages, but the examples site
  ships each example's TypeScript as a raw string in its chunk
  (`/examples/main-*.js`), which is the quickest way to read them.
- `ThreeView` throws `Invariant failed` if its container has zero size at
  construction (e.g. a hidden browser tab).
- macOS's bundled Python (3.9, old TLS) can't handshake with Overpass;
  shell out to `curl` from scripts instead. Overpass also answers HTML when
  busy, so retry and fall back to a mirror.

- `new ThreeView({ defaultAttribution: false })` removes the on-map credits
  button; `view.attribution` is then undefined. Google's Map Tiles terms
  require showing Google's logo and data credits on anything published.

- Production builds: Vite copies Navara's font worker verbatim, so the wasm
  it loads relative to itself (`navara_wasm_font_worker_bg-*.wasm`) is never
  emitted and text layers silently render nothing. Copy it into
  `dist/assets` in a `closeBundle` plugin (`vite.config.ts`).
- `vite preview` runs in serve mode: a `base` set only for
  `command === "build"` doesn't apply to it; check `isPreview` too.
- Fonts: Optima can't ship (Apple licence). URW Classico (Zapf's Optima
  revision for URW++) is on CTAN as OpenType under the AFPL
  (non-commercial). fontTools converts CFF to TrueType with `Cu2QuPen`.

## Data

- City of LA Bureau of Street Lighting poles: ArcGIS FeatureServer
  `services6.arcgis.com/dQFzaYk2ngJmjVgE/.../Streetlights/FeatureServer/0`,
  paginated 2000 per page. Far denser than OSM `highway=street_lamp`
  (2,858 vs 142 in the original Silver Lake box). `scripts/fetch_lamps.py`.
- Lamp bases: `view.sampleTerrainMostDetailed(source, points)` works on a
  terrain source that has no layer, so bare-earth heights are available
  under Google tiles. Re:Earth's `cesium-mesh/ellipsoid` terrain is global and
  in ellipsoidal heights, which matches Google 3D Tiles.
- OSM splits streets into many short ways; merge them per name with
  shapely `linemerge` before laying out labels (`scripts/build_streets.py`).

## Google Photorealistic 3D Tiles

- They render as unlit `MeshBasicMaterial` with baked daylight. The layer's
  `model.color` and `lit` options are ignored for them.

## FogLight (street lamps)

- Surface lighting uses the effect's *input color* as albedo. Darkening the
  tiles first (tinting materials) also starves the lamp light. Instead keep
  full albedo and patch the composite line
  `finalColor = inputColor.rgb + fogColor` to scale only the base
  (`src/nightFogLight.ts`, via `setFragmentShader` on
  `handle.ref.raw.rawEffect`).
- The "is this sky?" test must use view distance, not `depth < 0.9999`:
  distant terrain also has perspective depth ~1 and would stay in daylight.
- Default `maxLightsPerTile` (64) overflows with thousands of dense lamps and
  shows the tile grid as blocks; 256 is plenty here (max ~40 per tile seen).
- `downsample: 1` keeps lamp cores pole-sized; the default 4 smears them.
- The shader rebuilds each pixel's world position in ECEF (~6.4e6 m), where
  float32 resolves only ~0.5 m. Close-up halos break into blocks. Patch
  `viewRay` and the surface `L` vector to camera-relative view space.
- `fogDensity` also drives each light's derived reach: at 0 the lamps stop
  lighting surfaces entirely.
- Glow and surface light scale together with `intensity`; glow alone scales
  with `fogDensity`, so balance the two with both sliders.

## Tone mapping and color

- Default AgX washes saturated sodium (2000 K, `#ff890e`) out to peach.
  ACES Filmic keeps the amber.
- Anything drawn before tone mapping (labels, rain) is HDR: divide picked
  colors by exposure or they blow out to white.
- Screen captures on these Macs are Display P3: sRGB `#ff890e` samples as
  (239,142,55). Convert before reading colors off a capture.

## Clouds

- Takram clouds (`clouds` effect) are lit only by sun and sky, so at night
  they render black and can't take point lights. A custom `EffectDesc`
  (`view.registerEffect`) that raymarches a noise slab lit by a mipmapped
  lamp-density map works and runs at 60 fps (`src/litClouds.ts`).
- Splat lamps as Gaussians, never one texel each, and clamp the minimum mip
  footprint; otherwise low clouds show glowing square columns per lamp.
- Let light reach clouds below lamp height too (`abs(z - lampZ)`).
- Clouds that only absorb leave "black holes" where no lamp reaches; keep
  self-shadow gentle and expose an opacity control separate from in-scatter.
- Do the math in a local east/north/up frame (CPU doubles) so the shader
  never handles ECEF-sized numbers.

## Labels

- Text is point-anchored only: no line placement, repeat spacing,
  letter-spacing or curved text (MapLibre `symbol-placement`,
  `symbol-spacing`, `text-letter-spacing` are unsupported). Lay labels out
  yourself; per-letter anchors rotated to the street tangent give curved text
  (`src/streetLabels.ts`). Per-feature `text`, `rotation` and `height` go
  through the FeatureEvaluator.
- Reject spots with a sharp kink between letters *and* cap the total bend over
  a label, or hairpin streets produce C/Z shapes.
- Letter-spacing for straight labels: add a hair-space glyph (U+200A, 0.02 em)
  to the font with fontTools and insert N of them between letters.
- `layer.update()` with `font` set, even unchanged, blanks a text layer. Set
  the font only at creation; recreate the layer to change it.
- Text lands in the MRT (G-buffer) pass whenever any effect needs G-buffers,
  so post composites (like the night-ambient patch) hit it. Render it through
  a proxy mesh in `ctx.scenes.transparent` instead.
- Fonts: Navara takes ttf/otf/woff/woff2, not `.ttc`.

## Tooling

- The desktop Browser pane, when hidden, stalls `requestAnimationFrame`, so
  screenshots go stale. Show the pane before judging renders.
- Pane screenshots are JPEG; their 8×8 blocks look like render artifacts on
  smooth dark gradients. For pixel-level checks, `gl.readPixels` inside a
  `view.on("postRender")` callback (the canvas has no preserved drawing
  buffer) and show a nearest-neighbor upscale on the page.
