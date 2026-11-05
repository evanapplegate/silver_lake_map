# Silver Lake · 2000K

Silver Lake, Los Angeles, at night in the rain: Google Photorealistic 3D Tiles
lit only by the real City of LA streetlights as 2000 K low-pressure sodium,
with volumetric fog, lamp-lit low clouds, rain and curved street labels.
Built on [Navara](https://navara.world/).

Live: https://evanapplegate.github.io/silver_lake_map/

## Run locally

```bash
npm install
cp .env.example .env.local   # add the dev Maps key
npm run dev                  # http://localhost:5173
```

`npm run build && npx vite preview` serves the production build at
http://localhost:4173/silver_lake_map/.

## Deploy

Pushing to `main` runs `.github/workflows/deploy.yml`, which builds with the
production key from the `GOOGLE_MAPS_API_KEY` repo secret and publishes `dist`
to GitHub Pages as an artifact. The build fails rather than deploying a
keyless site if the secret is missing.

## API keys

The Map Tiles API key has to reach the browser, so it is visible in the
shipped JavaScript no matter how it's injected. Keeping it out of git stops
it leaking through history and forks; the real protection is restricting it.

- **Storage.** The key lives in `.env.local` (gitignored) for dev and in the
  `GOOGLE_MAPS_API_KEY` repo secret for deploys. It's never committed or put
  in a URL.
- **Restrictions** (Google Cloud Console, APIs & Services, Credentials, on the
  key):
  - Application restriction: Websites, referrers
    `https://evanapplegate.github.io/*`, `http://localhost:5173/*` and
    `http://localhost:4173/*`. Browsers send only the origin as the Referer
    on cross-origin tile requests, so a path-scoped pattern like
    `.../silver_lake_map/*` would block the site itself.
  - API restriction: Map Tiles API only
  - Quotas: cap Map Tiles API requests per day, and set a billing budget
    alert
- **Stricter option:** split into a localhost-only dev key and a
  github.io-only production key, so a leaked dev key can't serve the site.
- **Rotation:** create the new key, update the secret
  (`gh secret set GOOGLE_MAPS_API_KEY`), re-run the deploy workflow, then
  delete the old key.

## Data

Regenerate with the scripts in `scripts/`.

- Streetlights: City of LA Bureau of Street Lighting
  (`scripts/fetch_lamps.py`)
- Street names and geometry: © OpenStreetMap contributors, ODbL
  (`scripts/build_streets.py`)
- Terrain heights: Re:Earth Terrain (Mapterhorn, EGM2008)
- 3D tiles: Google Maps Platform Photorealistic 3D Tiles

The on-map attribution UI is turned off. Google's and OpenStreetMap's terms
require visible credits on public pages, so restore them before using this
for anything beyond a personal demo.

## Fonts

Labels use URW Classico, Hermann Zapf's revision of Optima for URW++
(`fonts-src/classico`, built by `scripts/build_fonts.py`). It is distributed
under the Aladdin Free Public License, which allows non-commercial
distribution only; the licence ships alongside the fonts. Swap in an
OFL-licensed face before any commercial use. The control panel uses the
system Optima where installed and falls back to Classico.

See `LEARNINGS.md` for the Navara quirks and fixes behind all this.
