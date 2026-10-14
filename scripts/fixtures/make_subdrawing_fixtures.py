#!/usr/bin/env python3
"""Generates the sub-drawing pair of the reference drawing set (FDR rows 31, 34, 85).

Usage (standard library only):

    python3 scripts/fixtures/make_subdrawing_fixtures.py

The plot plan of the pair is tests/fixtures/dxf/r2018_plotplan.dxf (plant coordinates, metres). This
script writes two area layouts of its tank farm:

  - area_layout_local_mm.dxf: drawn in LOCAL coordinates in millimetres, rotated 15 degrees against
    plant north, with the plant grid and its E/N labels. Used for plant-coordinate calibration
    (row 31) and two-point alignment onto the plot plan (row 34).
  - area_layout_plant_mm_header.dxf: the same layout drawn in plant coordinates (metre values) but
    with a millimetre $INSUNITS header, as often found in CAD templates. Used for "shared
    coordinates" alignment (row 34).

plus tests/fixtures/dxf/subdrawings.json with the exact expected coordinates. Coordinates are
written with repr(), i.e. the shortest text that round-trips the float64 value exactly.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "tests" / "fixtures" / "dxf"

# Local frame of the area layout: plant point ORIGIN is local (0, 0); the sheet x axis points
# ROTATION_DEG anticlockwise from plant east; units millimetres.
ORIGIN = (600160.0, 2500100.0)
ROTATION_DEG = 15.0
MM_PER_M = 1000.0

GRID_E = [600150.0, 600200.0, 600250.0, 600300.0]
GRID_N = [2500100.0, 2500150.0, 2500200.0]
TANKS = [(600200.0, 2500150.0, 15.0), (600250.0, 2500150.0, 20.0)]
# Bund lines exactly as in r2018_plotplan.dxf (separate LINEs with 0.05 m gaps at the corners).
BX0, BY0, BX1, BY1, GAP = 600175.0, 2500120.0, 600280.0, 2500180.0, 0.05
BUND = [
    ((BX0 + GAP, BY0), (BX1 - GAP, BY0)),
    ((BX1, BY0 + GAP), (BX1, BY1 - GAP)),
    ((BX1 - GAP, BY1), (BX0 + GAP, BY1)),
    ((BX0, BY1 - GAP), (BX0, BY0 + GAP)),
]


def to_local(p: tuple[float, float]) -> tuple[float, float]:
    """Plant metres -> local millimetres."""
    t = math.radians(ROTATION_DEG)
    dx, dy = p[0] - ORIGIN[0], p[1] - ORIGIN[1]
    c, s = math.cos(t), math.sin(t)
    return ((c * dx + s * dy) * MM_PER_M, (-s * dx + c * dy) * MM_PER_M)


def identity(p: tuple[float, float]) -> tuple[float, float]:
    return p


def pairs(*items) -> str:
    out = []
    for i in range(0, len(items), 2):
        code, value = items[i], items[i + 1]
        if isinstance(value, float):
            value = repr(value)
        out.append(f"{code:>3}\n{value}\n")
    return "".join(out)


def section(name: str, body: str) -> str:
    return pairs(0, "SECTION", 2, name) + body + pairs(0, "ENDSEC")


LAYERS = [("GRID", 8, "CONTINUOUS"), ("GRID_TEXT", 7, "CONTINUOUS"), ("TANKS", 6, "CONTINUOUS"),
          ("BUND", 30, "CONTINUOUS"), ("TITLE", 2, "CONTINUOUS")]


def document(xf, scale: float, rot_deg: float, insunits: int, title: str) -> str:
    """xf maps plant metres to file coordinates; scale = file units per metre."""
    ents = []

    def line(a, b, layer):
        pa, pb = xf(a), xf(b)
        ents.append(pairs(0, "LINE", 8, layer, 10, pa[0], 20, pa[1], 30, 0.0, 11, pb[0], 21, pb[1], 31, 0.0))

    def circle(c, r, layer):
        pc = xf(c)
        ents.append(pairs(0, "CIRCLE", 8, layer, 10, pc[0], 20, pc[1], 30, 0.0, 40, r * scale))

    def text(p, s, h, layer, rot=0.0):
        pp = xf(p)
        ents.append(pairs(0, "TEXT", 8, layer, 10, pp[0], 20, pp[1], 30, 0.0, 40, h * scale, 1, s, 50, rot))

    for e in GRID_E:
        line((e, GRID_N[0] - 5.0), (e, GRID_N[-1] + 5.0), "GRID")
        text((e - 0.8, GRID_N[0] - 12.0), f"E {e:.0f}", 2.5, "GRID_TEXT", 90.0 - rot_deg)
    for n in GRID_N:
        line((GRID_E[0] - 5.0, n), (GRID_E[-1] + 5.0, n), "GRID")
        text((GRID_E[0] - 22.0, n + 0.8), f"N {n:.0f}", 2.5, "GRID_TEXT", 0.0 - rot_deg)
    for cx, cy, r in TANKS:
        circle((cx, cy), r, "TANKS")
        circle((cx, cy), r - 0.5, "TANKS")
    for a, b in BUND:
        line(a, b, "BUND")
    text((GRID_E[0], GRID_N[-1] + 12.0), title, 3.0, "TITLE", 0.0 - rot_deg)

    tables = pairs(0, "TABLE", 2, "LAYER", 70, len(LAYERS))
    for name, color, lt in LAYERS:
        tables += pairs(0, "LAYER", 2, name, 70, 0, 62, color, 6, lt)
    tables += pairs(0, "ENDTAB")
    return (
        section("HEADER", pairs(9, "$ACADVER", 1, "AC1015", 9, "$INSUNITS", 70, insunits))
        + section("TABLES", tables)
        + section("ENTITIES", "".join(ents))
        + pairs(0, "EOF")
    )


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    local = document(to_local, MM_PER_M, ROTATION_DEG, 4, "AREA LAYOUT - TANK FARM (LOCAL COORDINATES, mm)")
    (OUT / "area_layout_local_mm.dxf").write_text(local, encoding="ascii", newline="\n")
    plant = document(identity, 1.0, 0.0, 4, "AREA LAYOUT - TANK FARM (PLANT COORDINATES)")
    (OUT / "area_layout_plant_mm_header.dxf").write_text(plant, encoding="ascii", newline="\n")

    grid = [{"plant": [e, n], "local": list(to_local((e, n)))} for n in GRID_N for e in GRID_E]
    expectations = {
        "base": "r2018_plotplan.dxf",
        "origin": list(ORIGIN),
        "rotationDeg": ROTATION_DEG,
        "localUnitsPerMetre": MM_PER_M,
        "files": {
            "area_layout_local_mm.dxf": {"insunits": 4, "coordinates": "local"},
            "area_layout_plant_mm_header.dxf": {"insunits": 4, "coordinates": "plant"},
        },
        "gridIntersections": grid,
        "tanks": [
            {"plant": [cx, cy], "local": list(to_local((cx, cy))), "r": r, "rLocal": r * MM_PER_M}
            for cx, cy, r in TANKS
        ],
        "bundEnds": [
            {"plant": list(p), "local": list(to_local(p))} for a, b in BUND for p in (a, b)
        ],
    }
    (OUT / "subdrawings.json").write_text(json.dumps(expectations, indent=2) + "\n", encoding="utf-8")
    print("sub-drawing fixtures written")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
