# Fetch named OSM streets around Silver Lake and merge each street's ways
# into continuous chains, so curved labels have room to run.
#
#   python3 scripts/build_streets.py
import json
import subprocess
import time
from collections import defaultdict
from pathlib import Path

from shapely.geometry import LineString, MultiLineString
from shapely.ops import linemerge

BBOX = (34.072, -118.295, 34.1152, -118.2363)  # S, W, N, E; +0.5 mi N and E
RANK = {"motorway": 5, "trunk": 5, "primary": 4, "secondary": 3, "tertiary": 2}
QUERY = (
    "[out:json][timeout:90];"
    'way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street)$"]["name"]'
    f"{BBOX};out geom tags;"
)

# curl rather than urllib: macOS's bundled Python can't handshake with Overpass.
# Overpass answers HTML when busy, so retry and fall back to a mirror.
ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]


def fetch():
    for attempt in range(6):
        url = ENDPOINTS[attempt % len(ENDPOINTS)]
        raw = subprocess.run(
            ["curl", "-s", "--max-time", "120", "-A", "navara-test/1.0", url,
             "--data-urlencode", f"data={QUERY}"],
            capture_output=True,
        ).stdout
        try:
            return json.loads(raw)["elements"]
        except (ValueError, KeyError):
            time.sleep(5 * (attempt + 1))
    raise SystemExit("Overpass unavailable")


ways = fetch()

by_name = defaultdict(list)
rank = defaultdict(int)
for w in ways:
    pts = [(round(p["lon"], 6), round(p["lat"], 6)) for p in w.get("geometry", [])]
    if len(pts) < 2:
        continue
    name = w["tags"]["name"]
    by_name[name].append(LineString(pts))
    rank[name] = max(rank[name], RANK.get(w["tags"]["highway"], 1))

chains = []
for name, lines in by_name.items():
    merged = linemerge(MultiLineString(lines))
    parts = merged.geoms if merged.geom_type == "MultiLineString" else [merged]
    for part in parts:
        chains.append(
            {"n": name, "r": rank[name], "c": [[round(x, 6), round(y, 6)] for x, y in part.coords]}
        )

out = Path(__file__).resolve().parent.parent / "src" / "streets.json"
out.write_text(json.dumps(chains, separators=(",", ":")))
print(f"{len(ways)} ways -> {len(chains)} chains, {len(by_name)} names -> {out}")
