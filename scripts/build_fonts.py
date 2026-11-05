# Build the label fonts from URW Classico (Hermann Zapf's Optima revision
# for URW++, vendored in fonts-src/classico with its AFPL licence).
#
# - CFF outlines -> TrueType glyf (Navara loads ttf/otf; the hair-space
#   glyph below is simpler to add to glyf)
# - adds a hair space (U+200A, 0.02 em, no outline): Navara text has no
#   letter-spacing, so straight labels are tracked by inserting N of them
# - writes advance widths for printable ASCII to src/fontMetrics.json for the
#   curved-label layout
#
# AFPL: non-commercial distribution only, licence must travel with the files.
#
#   python3 scripts/build_fonts.py
import json
import shutil
from pathlib import Path

from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont, newTable
from fontTools.ttLib.tables._g_l_y_f import Glyph

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "fonts-src" / "classico"
OUT = ROOT / "public" / "fonts"
FACES = {
    "regular": "URWClassico-Regular.otf",
    "bold": "URWClassico-Bold.otf",
    "italic": "URWClassico-Italic.otf",
    "bolditalic": "URWClassico-BoldItalic.otf",
}
HAIR_SPACE = 0x200A
HAIR_ADVANCE = 0.02  # em


def otf_to_ttf(font: TTFont) -> None:
    order = font.getGlyphOrder()
    glyphs = font.getGlyphSet()
    glyf = newTable("glyf")
    glyf.glyphOrder = order
    glyf.glyphs = {}
    for name in order:
        pen = TTGlyphPen(glyphs)
        glyphs[name].draw(Cu2QuPen(pen, max_err=1.0, reverse_direction=True))
        glyf.glyphs[name] = pen.glyph()
    font["glyf"] = glyf
    font["loca"] = newTable("loca")
    del font["CFF "]
    if "VORG" in font:
        del font["VORG"]
    font["maxp"] = maxp = newTable("maxp")
    maxp.tableVersion = 0x00010000
    for attr in (
        "maxZones", "maxTwilightPoints", "maxStorage", "maxFunctionDefs", "maxInstructionDefs",
        "maxStackElements", "maxSizeOfInstructions", "maxComponentElements",
    ):
        setattr(maxp, attr, 0)
    maxp.maxZones = 1
    font["head"].glyphDataFormat = 0
    font["post"].formatType = 2.0
    font["post"].extraNames = []
    font["post"].mapping = {}
    font["post"].glyphOrder = order
    font.sfntVersion = "\x00\x01\x00\x00"


def add_hair_space(font: TTFont) -> None:
    name = "uni200A"
    if name in font.getGlyphOrder():
        return
    font.setGlyphOrder(font.getGlyphOrder() + [name])
    font["glyf"].glyphs[name] = Glyph()
    font["hmtx"].metrics[name] = (round(font["head"].unitsPerEm * HAIR_ADVANCE), 0)
    for table in font["cmap"].tables:
        if table.isUnicode():
            table.cmap[HAIR_SPACE] = name


OUT.mkdir(parents=True, exist_ok=True)
metrics = {}
for weight, file in FACES.items():
    font = TTFont(SRC / file)
    cmap, hmtx, upm = font.getBestCmap(), font["hmtx"], font["head"].unitsPerEm
    metrics[weight] = {
        chr(cp): round(hmtx[cmap[cp]][0] / upm, 4) for cp in range(32, 127) if cp in cmap
    }
    otf_to_ttf(font)
    add_hair_space(font)
    font.save(OUT / f"classico-{weight}.ttf")
    print(OUT / f"classico-{weight}.ttf")

for doc in ("AFPL.htm", "README"):
    shutil.copy(SRC / doc, OUT / f"classico-{doc}")

(ROOT / "src" / "fontMetrics.json").write_text(json.dumps(metrics, separators=(",", ":")))
print(ROOT / "src" / "fontMetrics.json")
