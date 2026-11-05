import { copyFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { defineConfig, type Plugin } from "vite";

// Navara's font worker is copied into the build verbatim, so Vite never sees
// the wasm it loads relative to itself; without it, labels silently don't
// render in production. Copy that wasm next to the worker.
const navaraFontWasm = (): Plugin => {
  let outDir = "dist";
  return {
    name: "navara-font-worker-wasm",
    apply: "build",
    configResolved: (c) => void (outDir = c.build.outDir),
    closeBundle() {
      const require = createRequire(import.meta.url);
      const assets = join(dirname(require.resolve("@navaramap/three")), "assets");
      for (const f of readdirSync(assets))
        if (/^navara_wasm_font_worker_bg-.*\.wasm$/.test(f))
          copyFileSync(join(assets, f), join(outDir, "assets", f));
    },
  };
};

export default defineConfig(({ command, isPreview }) => ({
  plugins: [navaraFontWasm()],
  // GitHub Pages project site: evanapplegate.github.io/silver_lake_map/
  base: command === "build" || isPreview ? "/silver_lake_map/" : "/",
  // Navara resolves its wasm/worker/atmosphere assets via import.meta.url,
  // which breaks if Vite pre-bundles the packages.
  optimizeDeps: {
    exclude: [
      "@navaramap/three",
      "@navaramap/three-default-descs",
      "@navaramap/three-default-plugin",
      "@navaramap/three-plugins",
    ],
  },
  build: { target: "esnext" },
  esbuild: { target: "esnext" },
  server: { port: 5173 },
}));
