# Fetch City of LA Bureau of Street Lighting poles for the scene into
# src/lamps.json as [lng, lat] pairs.
#
#   python3 scripts/fetch_lamps.py
import json
import subprocess
import urllib.parse
from pathlib import Path

# Silver Lake, plus 0.5 mi north and east of the original box
BBOX = (-118.290, 34.075, -118.2413, 34.1122)  # W, S, E, N
URL = (
    "https://services6.arcgis.com/dQFzaYk2ngJmjVgE/arcgis/rest/services/"
    "Streetlights/FeatureServer/0/query"
)
PAGE = 2000

points = set()
offset = 0
while True:
    params = {
        "where": "1=1",
        "geometry": ",".join(map(str, BBOX)),
        "geometryType": "esriGeometryEnvelope",
        "inSR": 4326,
        "spatialRel": "esriSpatialRelIntersects",
        "outFields": "SLID",
        "outSR": 4326,
        "resultOffset": offset,
        "resultRecordCount": PAGE,
        "f": "json",
    }
    # curl rather than urllib: macOS's bundled Python has an old TLS stack
    raw = subprocess.run(
        ["curl", "-s", "--max-time", "90", f"{URL}?{urllib.parse.urlencode(params)}"],
        check=True, capture_output=True,
    ).stdout
    page = json.loads(raw)
    feats = page.get("features", [])
    points.update((round(f["geometry"]["x"], 6), round(f["geometry"]["y"], 6)) for f in feats)
    if not page.get("exceededTransferLimit") and len(feats) < PAGE:
        break
    offset += PAGE

out = Path(__file__).resolve().parent.parent / "src" / "lamps.json"
out.write_text(json.dumps(sorted(points)))
print(f"{len(points)} lamps -> {out}")
