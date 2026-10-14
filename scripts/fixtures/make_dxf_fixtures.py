#!/usr/bin/env python3
"""Generates the reference DXF fixture set used by src/import/dxf tests.

Usage (ezdxf is a dev-time dependency of this script only, never of the app):

    python3 -m venv /tmp/dxf-venv && /tmp/dxf-venv/bin/pip install ezdxf
    /tmp/dxf-venv/bin/python scripts/fixtures/make_dxf_fixtures.py

Writes tests/fixtures/dxf/*.dxf plus tests/fixtures/dxf/expectations.json. The output is
deterministic (fixed metadata, fixed handles). Expected geometry for block references is computed
independently with ezdxf's own block explosion (virtual entities), not with the TypeScript code.
"""

from __future__ import annotations

import json
import math
import os
import subprocess
import sys
from pathlib import Path

# ezdxf writes the CLASSES section in set-iteration order: pin string hashing for reproducible files.
if os.environ.get("PYTHONHASHSEED") != "0":
    os.environ["PYTHONHASHSEED"] = "0"
    os.execv(sys.executable, [sys.executable, *sys.argv])

import ezdxf
from ezdxf import units
from ezdxf.lldxf.const import BOUNDARY_PATH_EXTERNAL, BOUNDARY_PATH_OUTERMOST
from ezdxf.enums import TextEntityAlignment
from ezdxf.math import OCS, Vec3
from ezdxf.render import hatching

ezdxf.options.write_fixed_meta_data_for_testing = True

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "tests" / "fixtures" / "dxf"
ARABIC = "منطقة الخطر"
FLAG_CLOSED, FLAG_IN_BLOCK, FLAG_PATTERN, FLAG_HIDDEN, FLAG_DERIVED = 1, 2, 4, 8, 16

ACI = {1: 0xFF0000, 2: 0xFFFF00, 3: 0x00FF00, 4: 0x00FFFF, 5: 0x0000FF, 6: 0xFF00FF, 7: 0xFFFFFF,
       8: 0x808080, 9: 0xC0C0C0, 30: 0xFF7F00}


# --------------------------------------------------------------------------------------------
# Expectation builders


class Expect:
    """Collects expectations for one fixture file."""

    def __init__(self, file: str):
        self.data: dict = {
            "file": file,
            "entities": [],
            "texts": [],
            "hatches": [],
            "splines": [],
            "ellipsePoints": [],
            "props": [],
        }

    def __setitem__(self, key, value):
        self.data[key] = value

    def ent(self, e, insert=None, tol=1e-9, handle=None, **props):
        g = geom_of(e)
        if g is None:
            return
        rec = {"handle": handle or e.dxf.handle, "insert": insert, "tol": tol, **g}
        rec.update(props)
        self.data["entities"].append(rec)

    def text(self, e, text, insert=None, tol=1e-9, handle=None, full=True, **extra):
        self.data["texts"].append(text_of(e, text, insert, tol, handle, full, **extra))

    def prop(self, handle, insert=None, **props):
        self.data["props"].append({"handle": handle, "insert": insert, **props})


def v2(p) -> list[float]:
    return [float(p[0]), float(p[1])]


def geom_of(e) -> dict | None:
    t = e.dxftype()
    if t == "LINE":
        return {"kind": "LINE", "geom": v2(e.dxf.start) + v2(e.dxf.end)}
    if t == "POINT":
        return {"kind": "POINT", "geom": v2(e.dxf.location)}
    if t == "CIRCLE":
        c = e.ocs().to_wcs(e.dxf.center)
        return {"kind": "CIRCLE", "geom": v2(c) + [e.dxf.radius]}
    if t == "ARC":
        ocs = e.ocs()
        c = e.dxf.center
        r = e.dxf.radius
        a0 = e.dxf.start_angle
        a1 = e.dxf.end_angle
        sweep = (a1 - a0) % 360 or 360
        am = math.radians(a0 + sweep / 2)
        mid = ocs.to_wcs(Vec3(c.x + r * math.cos(am), c.y + r * math.sin(am), c.z))
        return {
            "kind": "ARC",
            "c": v2(ocs.to_wcs(c)),
            "r": r,
            "start": v2(e.start_point),
            "end": v2(e.end_point),
            "mid": v2(mid),
        }
    if t == "ELLIPSE":
        ct = e.construction_tool()
        p0, p1 = ct.start_param, ct.end_param
        if p1 <= p0:
            p1 += math.tau
        params = [p0 + (p1 - p0) * k / 6 for k in range(7)]
        return {"kind": "ELLIPSE", "c": v2(ct.center), "points": [v2(p) for p in ct.vertices(params)]}
    if t == "LWPOLYLINE":
        sign = -1 if e.dxf.extrusion.z < 0 else 1
        pts = list(e.vertices_in_wcs())
        bulges = [b for (*_, b) in e.get_points("xyseb")]
        return {
            "kind": "POLY",
            "pts": [v2(p) + [b * sign] for p, b in zip(pts, bulges)],
            "closed": bool(e.closed),
        }
    if t == "POLYLINE":
        if e.is_3d_polyline:
            return {"kind": "POLY", "pts": [v2(p) + [0.0] for p in e.points()], "closed": bool(e.is_closed)}
        ocs = e.ocs()
        sign = -1 if e.dxf.extrusion.z < 0 else 1
        pts = []
        for v in e.vertices:
            pts.append(v2(ocs.to_wcs(v.dxf.location)) + [v.dxf.bulge * sign])
        return {"kind": "POLY", "pts": pts, "closed": bool(e.is_closed)}
    if t in ("SOLID", "TRACE"):
        # ezdxf returns the vertices already in drawing order (DXF order 1, 2, 4, 3).
        return {"kind": "FILL", "rings": [[v2(p) for p in e.wcs_vertices(close=False)]]}
    if t == "3DFACE":
        vs = [v2(p) for p in e.wcs_vertices(close=False)]
        if len(vs) == 4 and vs[3] == vs[2]:
            vs = vs[:3]
        return {"kind": "POLY", "pts": [p + [0.0] for p in vs], "closed": True}
    return None


H_ALIGN = {0: 0, 1: 1, 2: 2, 3: 0, 4: 1, 5: 0}


def text_of(e, text, insert, tol, handle, full, **extra) -> dict:
    t = e.dxftype()
    rec: dict = {"handle": handle or e.dxf.handle, "insert": insert, "tol": tol, "text": text}
    if t == "MTEXT":
        ap = e.dxf.attachment_point
        rec.update(
            {
                "anchor": v2(e.dxf.insert),
                "hAlign": (ap - 1) % 3,
                "vAlign": [3, 2, 1][(ap - 1) // 3],
            }
        )
        if full:
            rec["height"] = e.dxf.char_height
            rec["rotation"] = math.radians(e.get_rotation()) % math.tau
    else:
        ocs = e.ocs()
        halign = e.dxf.get("halign", 0)
        valign = e.dxf.get("valign", 0)
        if halign in (3, 5) or (halign == 0 and valign == 0):
            p = e.dxf.insert
        else:
            p = e.dxf.align_point
        rec["anchor"] = v2(ocs.to_wcs(p))
        rec["hAlign"] = H_ALIGN[halign]
        rec["vAlign"] = 2 if halign == 4 else (0 if halign in (3, 5) else valign)
        if full:
            rec["height"] = e.dxf.height
            gen = e.dxf.get("text_generation_flag", 0) & 6
            # Upside-down text is stored as rotation + π with a mirrored (negative) width factor.
            rec["rotation"] = (math.radians(e.dxf.rotation) + (math.pi if gen == 4 else 0)) % math.tau
            rec["widthSign"] = -1 if gen in (2, 4) else 1
    rec.update(extra)
    return rec


def expand_insert(ins, top_handle: str, out: list):
    """Recursively explodes a block reference with ezdxf → (source handle, top handle, virtual)."""
    refs = list(ins.multi_insert()) if ins.mcount > 1 else [ins]
    for ref in refs:
        for v in ref.virtual_entities():
            src = v.source_of_copy
            if v.dxftype() == "INSERT":
                expand_insert(v, top_handle, out)
            elif src is not None:
                out.append((src.dxf.handle, top_handle, v))


def expand_dimension(dim, out: list):
    for v in dim.virtual_entities():
        src = v.source_of_copy
        if v.dxftype() == "INSERT":
            expand_insert(v, dim.dxf.handle, out)
        elif src is not None:
            out.append((src.dxf.handle, dim.dxf.handle, v))


def layer_table(doc) -> dict:
    out = {}
    for layer in doc.layers:
        aci = layer.dxf.color
        tc = layer.dxf.get("true_color") if doc.dxfversion >= "AC1018" else None  # 420 exists since R2004
        color = tc & 0xFFFFFF if tc is not None else ACI.get(abs(aci), None)
        rec = {
            "off": aci < 0,
            "frozen": bool(layer.dxf.flags & 1),
            "linetype": layer.dxf.linetype,
            # R12 cannot store the plot flag; "Defpoints" never plots in AutoCAD.
            "plot": bool(layer.dxf.get("plot", 1)) and layer.dxf.name.upper() != "DEFPOINTS",
        }
        if color is not None:
            rec["color"] = color
        lw = layer.dxf.get("lineweight", -3)
        rec["lineweight"] = lw if lw >= 0 else -3
        out[layer.dxf.name] = rec
    return out


def counts_of(layout) -> dict:
    counts: dict = {}
    for e in layout:
        t = e.dxftype()
        counts[t] = counts.get(t, 0) + 1
        if t == "INSERT":
            n = len(e.attribs)
            if n:
                counts["ATTRIB"] = counts.get("ATTRIB", 0) + n
    return counts


SUPPORTED = {
    "LINE", "POINT", "CIRCLE", "ARC", "ELLIPSE", "LWPOLYLINE", "POLYLINE", "SPLINE", "SOLID", "TRACE",
    "3DFACE", "HATCH", "TEXT", "MTEXT", "INSERT", "DIMENSION", "LEADER", "ATTDEF", "ATTRIB",
}


def split_counts(counts: dict, layout) -> tuple[dict, dict]:
    imported, skipped = {}, {}
    for e in layout:
        t = e.dxftype()
        if t == "POLYLINE" and (e.is_poly_face_mesh or e.is_polygon_mesh):
            key = "POLYLINE (polyface mesh)" if e.is_poly_face_mesh else "POLYLINE (polygon mesh)"
            skipped[key] = skipped.get(key, 0) + 1
        elif t in SUPPORTED:
            imported[t] = imported.get(t, 0) + 1
            if t == "INSERT" and len(e.attribs):
                imported["ATTRIB"] = imported.get("ATTRIB", 0) + len(e.attribs)
        else:
            skipped[t] = skipped.get(t, 0) + 1
    return imported, skipped


def hatch_expect(h, insert=None) -> dict:
    segs = list(hatching.hatch_entity(h, jiggle_origin=False)) if h.dxf.solid_fill == 0 else []
    return {
        "handle": h.dxf.handle,
        "insert": insert,
        "rings": len(h.paths),
        "pattern": h.dxf.solid_fill == 0,
        "segments": len(segs),
        "length": sum((b - a).magnitude for a, b in segs),
    }


def add_solid3d(layout):
    """3DSOLID with a minimal (dummy) ACIS body — ezdxf does not export solids without data."""
    s = layout.add_3dsolid()
    s.sat = ["400 0 1 0", "16 Autodesk AutoCAD 19 ASM 220.0.0.6202 NT 0", "1 9.9999999999999995e-07 1e-10", "End-of-ACIS-data"]
    return s


def save(doc, name: str, exp: Expect | None, fmt: str = "asc"):
    path = OUT / name
    doc.saveas(path, fmt=fmt)
    if exp is not None:
        exp["binary"] = fmt == "bin"
    return path


# --------------------------------------------------------------------------------------------
# Fixture: R12 (AC1009) — every R12 entity type, \U+ escapes, R12 paper space


def make_r12(expectations: list):
    doc = ezdxf.new("R12", setup=True)
    msp = doc.modelspace()
    exp = Expect("r12_entities.dxf")
    doc.layers.add("GEOM", color=1, linetype="DASHED")
    off = doc.layers.add("OFFLAYER", color=3)
    off.off()
    frozen = doc.layers.add("FROZEN", color=5)
    frozen.freeze()
    doc.layers.add("TXT", color=2)

    e = msp.add_line((0, 0), (100, 50), dxfattribs={"layer": "GEOM"})
    exp.ent(e, color=0xFF0000, layer="GEOM", linetype="DASHED")
    e = msp.add_line((0, 0, 5), (10, 10, 7), dxfattribs={"color": 4, "layer": "OFFLAYER"})
    exp.ent(e, color=0x00FFFF, layer="OFFLAYER")
    e = msp.add_line((5, 5), (6, 6), dxfattribs={"layer": "FROZEN"})
    exp.ent(e, color=0x0000FF, layer="FROZEN")
    e = msp.add_circle((50, 50), 12.5, dxfattribs={"layer": "GEOM"})
    exp.ent(e, color=0xFF0000)
    e = msp.add_arc((80, 20), 10, 30, 120)
    exp.ent(e)
    e = msp.add_arc((10, 10), 5, 0, 90, dxfattribs={"extrusion": (0, 0, -1)})
    exp.ent(e)
    e = msp.add_circle((20, 5), 3, dxfattribs={"extrusion": (0, 0, -1)})
    exp.ent(e)
    e = msp.add_point((5, 7))
    exp.ent(e)
    pl = msp.add_polyline2d([(0, 0), (10, 0), (10, 10), (0, 10)], close=True)
    pl.vertices[1].dxf.bulge = 0.5
    exp.ent(pl)
    pl = msp.add_polyline2d([(30, 0), (40, 0), (40, 10)], dxfattribs={"extrusion": (0, 0, -1)})
    pl.vertices[0].dxf.bulge = -0.25
    exp.ent(pl)
    e = msp.add_polyline3d([(0, 0, 0), (5, 5, 5), (10, 0, 10)])
    exp.ent(e)
    pf = msp.add_polyface()
    pf.append_face([(0, 0, 0), (1, 0, 0), (1, 1, 0)])
    e = msp.add_solid([(0, -20), (10, -20), (0, -10), (10, -10)], dxfattribs={"color": 1})
    exp.ent(e, color=0xFF0000)
    e = msp.add_solid([(20, -20), (30, -20), (25, -10)])
    exp.ent(e)
    e = msp.add_trace([(40, -20), (50, -20), (40, -18), (50, -18)])
    exp.ent(e)
    e = msp.add_3dface([(0, 0, 0), (10, 0, 0), (10, 10, 5), (0, 10, 5)])
    exp.ent(e)

    e = msp.add_text("Hello", height=2.5, rotation=30, dxfattribs={"layer": "TXT"}).set_placement((1, 2))
    exp.text(e, "Hello")
    exp.prop(e.dxf.handle, color=0xFFFF00, layer="TXT")
    e = msp.add_text("Centre", height=3).set_placement((50, 60), align=TextEntityAlignment.MIDDLE_CENTER)
    exp.text(e, "Centre")
    e = msp.add_text("TopRight", height=1.5).set_placement((70, 60), align=TextEntityAlignment.TOP_RIGHT)
    exp.text(e, "TopRight")
    e = msp.add_text(ARABIC, height=2).set_placement((0, -30))
    exp.text(e, ARABIC)
    e = msp.add_text("%%c50 45%%d %%p0.5 100%%%", height=2).set_placement((0, -35))
    exp.text(e, "Ø50 45° ±0.5 100%")
    e = msp.add_text("Back", height=2, dxfattribs={"text_generation_flag": 2}).set_placement((0, -40))
    exp.text(e, "Back")
    e = msp.add_text("Upside", height=2, dxfattribs={"text_generation_flag": 4}).set_placement((20, -40))
    exp.text(e, "Upside")
    e = msp.add_text("Mirrored OCS", height=2, dxfattribs={"extrusion": (0, 0, -1)}).set_placement((5, -45))
    exp.text(e, "Mirrored OCS", full=False)

    blk = doc.blocks.new("TAG", base_point=(0, 0))
    blk.add_circle((0, 0), 1)
    blk.add_attdef("NAME", (0, -2), dxfattribs={"height": 0.5})
    ins = msp.add_blockref("TAG", (30, 30))
    ins.add_auto_attribs({"NAME": "P-101"})
    a = ins.add_attrib("SECRET", "hidden value", (30, 25), dxfattribs={"flags": 1, "height": 0.5})
    tag_ents: list = []
    expand_insert(ins, ins.dxf.handle, tag_ents)
    for h, top, v in tag_ents:
        exp.ent(v, insert=top, handle=h, tol=1e-9)
    exp.text(ins.attribs[0], "P-101", insert=ins.dxf.handle, hidden=False)
    exp.text(a, "hidden value", insert=ins.dxf.handle, hidden=True)

    dim = msp.add_linear_dim(base=(0, 20), p1=(0, 15), p2=(30, 15))
    dim.render()
    dim_ents: list = []
    expand_dimension(dim.dimension, dim_ents)
    for h, top, v in dim_ents:
        if v.dxftype() == "LINE":
            exp.ent(v, insert=top, handle=h, tol=1e-9)

    psp = doc.paperspace()
    psp.add_line((0, 0), (100, 0))
    psp.add_text("Paper", height=5).set_placement((10, 10))

    counts, skipped = split_counts(counts_of(msp), msp)
    exp["version"] = "AC1009"
    exp["insunits"] = 0
    exp["layouts"] = ["Model", "Layout1"]
    exp["layers"] = layer_table(doc)
    exp["counts"] = counts
    exp["skipped"] = skipped
    exp["inserts"] = 2
    exp["layoutCounts"] = {"Layout1": split_counts({}, psp)[0]}
    save(doc, "r12_entities.dxf", exp)
    expectations.append(exp.data)

    exp_bin = Expect("r12_entities_binary.dxf")
    exp_bin.data.update({k: v for k, v in exp.data.items() if k != "file"})
    exp_bin["sameAs"] = "r12_entities.dxf"
    save(doc, "r12_entities_binary.dxf", exp_bin, fmt="bin")
    expectations.append(exp_bin.data)


# --------------------------------------------------------------------------------------------
# Fixture: R2000 (AC1015) with ANSI_1256 code page — LWPOLYLINE, ELLIPSE, SPLINE, HATCH, MTEXT …


def make_r2000(expectations: list):
    doc = ezdxf.new("R2000", setup=True)
    doc.encoding = "cp1256"  # writes $DWGCODEPAGE = ANSI_1256 and encodes strings in cp1256
    doc.header["$LTSCALE"] = 3.0
    doc.units = units.M
    msp = doc.modelspace()
    exp = Expect("r2000_cp1256.dxf")
    tc = doc.layers.add("LWLAYER", color=3)
    tc.dxf.lineweight = 50
    tc.dxf.plot = 0
    doc.layers.add("HATCH", color=3)

    e = msp.add_lwpolyline([(0, 0, 0, 0, 0.5), (10, 0, 0, 0, 0), (10, 10, 0, 0, -1), (0, 10, 0, 0, 0)], format="xyseb", close=True)
    exp.ent(e, layer="0")
    e = msp.add_lwpolyline([(20, 0), (30, 5), (40, 0)], dxfattribs={"elevation": 7.5, "const_width": 0.5, "layer": "LWLAYER"})
    exp.ent(e, color=0x00FF00, lineweight=50, layer="LWLAYER")
    e = msp.add_lwpolyline([(50, 0, 0, 0, 1), (60, 0)], format="xyseb", dxfattribs={"extrusion": (0, 0, -1)})
    exp.ent(e)
    e = msp.add_line((0, -5), (10, -5), dxfattribs={"lineweight": 35, "ltscale": 2.0, "linetype": "DASHED", "color": 30})
    exp.ent(e, color=0xFF7F00, lineweight=35, linetype="DASHED", ltscale=6.0)

    e = msp.add_ellipse((0, 30), major_axis=(10, 5), ratio=0.4)
    exp.ent(e)
    e = msp.add_ellipse((30, 30), major_axis=(0, 8), ratio=0.5, start_param=0.3, end_param=2.5)
    exp.ent(e)
    e = msp.add_ellipse((60, 30), major_axis=(5, 0), ratio=0.5, start_param=0, end_param=math.pi, dxfattribs={"extrusion": (0, 0, -1)})
    exp.ent(e)

    # Splines: control points, fit points only, exact rational quarter circle, closed.
    e = msp.add_open_spline([(0, 50), (10, 60), (20, 40), (30, 55), (40, 50)], degree=3)
    exp.data["splines"].append(
        {"handle": e.dxf.handle, "through": [v2(e.control_points[0]), v2(e.control_points[-1])],
         "near": [v2(p) for p in e.construction_tool().approximate(16)], "nearTol": 0.02}
    )
    fit = [(50, 50), (55, 58), (62, 52), (70, 60)]
    e = msp.add_spline(fit_points=fit)
    exp.data["splines"].append({"handle": e.dxf.handle, "through": [list(p) for p in fit], "tol": 1e-9})
    w = math.sqrt(0.5)
    e = msp.add_rational_spline([(110, 50), (110, 60), (100, 60)], weights=[1, w, 1], degree=2)
    exp.data["splines"].append({"handle": e.dxf.handle, "onCircle": {"c": [100, 50], "r": 10}, "tol": 1e-9,
                                "through": [[110, 50], [100, 60]]})
    e = msp.add_spline()
    e.set_closed([(120, 50, 0), (130, 50, 0), (130, 60, 0), (120, 60, 0)], degree=3)
    exp.data["splines"].append(
        {"handle": e.dxf.handle, "closed": True, "near": [v2(p) for p in e.construction_tool().approximate(16)], "nearTol": 0.02}
    )

    # Solid hatch with a hole.
    h = msp.add_hatch(color=3, dxfattribs={"layer": "HATCH"})
    h.paths.add_polyline_path([(0, 80), (20, 80), (20, 100), (0, 100)], is_closed=True, flags=BOUNDARY_PATH_EXTERNAL)
    h.paths.add_polyline_path([(5, 85), (15, 85), (15, 95), (5, 95)], is_closed=True, flags=BOUNDARY_PATH_OUTERMOST)
    exp.data["hatches"].append({**hatch_expect(h), "ringPts": [[[0, 80], [20, 80], [20, 100], [0, 100]], [[5, 85], [15, 85], [15, 95], [5, 95]]]})
    exp.prop(h.dxf.handle, color=0x00FF00, layer="HATCH")
    # Edge-path hatch: line, CCW arc, CW arc, elliptic arc, spline.
    h = msp.add_hatch(color=1)
    ep = h.paths.add_edge_path()
    ep.add_line((30, 80), (40, 80))
    ep.add_arc((40, 85), 5, -90, 90, ccw=True)
    ep.add_line((40, 90), (35, 90))
    # Clockwise arc from (35, 90) to (30, 90) through the bottom (ezdxf keeps CCW angles + a ccw flag).
    ep.add_arc((32.5, 90), 2.5, 180, 360, ccw=False)
    ep.add_ellipse((30, 85), major_axis=(0, 5), ratio=0.4, start_angle=0, end_angle=90, ccw=True)
    ep.add_spline(control_points=[(28, 85), (27, 83), (31, 82), (30, 80)], knot_values=[0, 0, 0, 0, 1, 1, 1, 1], degree=3)
    # Points on the boundary: CCW arc mid (45, 85); the CW arc passes below its centre (32.5, 87.5);
    # the elliptic arc runs from (30, 90) to (28, 85); the spline ends at (30, 80).
    exp.data["hatches"].append(
        {**hatch_expect(h), "onBoundary": [[30, 80], [40, 80], [45, 85], [40, 90], [35, 90], [32.5, 87.5], [30, 90], [28, 85]],
         "offBoundary": [[32.5, 92.5]]}
    )
    # Pattern hatch ANSI31.
    h = msp.add_hatch(color=5)
    h.set_pattern_fill("ANSI31", scale=0.5)
    h.paths.add_polyline_path([(60, 80), (80, 80), (80, 95), (60, 95)], is_closed=True)
    h.paths.add_polyline_path([(65, 85), (70, 85), (70, 90), (65, 90)], is_closed=True)
    exp.data["hatches"].append(hatch_expect(h))

    # Text in the ANSI_1256 code page and MTEXT formatting.
    e = msp.add_text(ARABIC, height=2.5).set_placement((0, 120))
    exp.text(e, ARABIC)
    e = msp.add_mtext(
        "{\\fArial|b1|i0|c178|p34;Bold} line1\\Pline2 \\S1/2; \\H2.5x;big\\~end {\\C1;red} \\L\\lunder 50%%d",
        dxfattribs={"char_height": 2.5, "width": 40, "attachment_point": 5, "insert": (0, 130)},
    )
    exp.text(e, "Bold line1\nline2 1/2 big\u00a0end red under 50°")
    long_text = "Long MTEXT " + " ".join(f"word{i:03d}" for i in range(80))
    e = msp.add_mtext(long_text, dxfattribs={"char_height": 1, "insert": (0, 140), "attachment_point": 1})
    exp.text(e, long_text)
    e = msp.add_mtext(ARABIC + "\\P%%c25", dxfattribs={"char_height": 2, "insert": (0, 150), "attachment_point": 9,
                                                         "rotation": 90})
    exp.text(e, ARABIC + "\nØ25")
    e = msp.add_mtext("Stack \\S1^2; \\S3#4;", dxfattribs={"char_height": 2, "insert": (0, 160)})
    exp.text(e, "Stack 1/2 3/4")

    e = msp.add_leader([(0, 170), (10, 180), (20, 180)])
    exp.data["entities"].append(
        {"handle": e.dxf.handle, "insert": None, "tol": 1e-9, "kind": "POLY", "closed": False,
         "pts": [[0, 170, 0], [10, 180, 0], [20, 180, 0]]}
    )
    add_solid3d(msp)
    msp.add_ray((0, 0), (1, 1))
    msp.add_xline((0, 0), (1, 0))
    msp.add_point((1, 1))

    counts, skipped = split_counts({}, msp)
    exp["version"] = "AC1015"
    exp["insunits"] = 6
    exp["layouts"] = ["Model", "Layout1"]
    exp["layers"] = layer_table(doc)
    exp["counts"] = counts
    exp["skipped"] = skipped
    exp["codepage"] = "ANSI_1256"
    save(doc, "r2000_cp1256.dxf", exp)
    expectations.append(exp.data)


# --------------------------------------------------------------------------------------------
# Fixture: R2010 (AC1024) — nested/mirrored/arrayed/OCS block references, inheritance, layouts


def make_r2010(expectations: list):
    doc = ezdxf.new("R2010", setup=True)
    doc.units = units.MM
    msp = doc.modelspace()
    exp = Expect("r2010_blocks.dxf")
    walls = doc.layers.add("WALLS", color=5)
    walls.dxf.lineweight = 50
    doc.layers.add("EQUIP", color=3, linetype="DASHED")
    doc.layers.add("ANNO", color=2)

    leaf = doc.blocks.new("LEAF")
    l_byblock = leaf.add_line((0, 0), (2, 0), dxfattribs={"color": 0, "linetype": "BYBLOCK", "lineweight": -2})
    c_bylayer = leaf.add_circle((1, 1), 0.5)
    a_walls = leaf.add_arc((0, 0), 1, 0, 90, dxfattribs={"layer": "WALLS"})
    l_red = leaf.add_line((0, 0), (0, 2), dxfattribs={"color": 1})
    leaf.add_lwpolyline([(0, 0, 0, 0, 0.5), (1, 0, 0, 0, 0), (1, 1, 0, 0, 0)], format="xyseb")
    leaf.add_text("L", height=0.3, dxfattribs={"color": 0}).set_placement((0, 2))

    mid = doc.blocks.new("MID", base_point=(1, 1))
    mid.add_blockref("LEAF", (5, 0), dxfattribs={"rotation": 90, "color": 0})
    l_mid = mid.add_line((0, 0), (0, 3), dxfattribs={"color": 0})

    top = doc.blocks.new("TOP")
    top.add_blockref("MID", (10, 0), dxfattribs={"xscale": 2, "yscale": 2, "zscale": 2, "color": 0})
    top.add_blockref("MID", (-10, 0), dxfattribs={"xscale": -1, "color": 0})
    top.add_blockref("LEAF", (0, -10), dxfattribs={"color": 256})
    p_top = top.add_lwpolyline([(0, 0, 0, 0, 1), (4, 0, 0, 0, 0)], format="xyseb")

    inserts = []
    i1 = msp.add_blockref("TOP", (100, 200), dxfattribs={"layer": "EQUIP", "color": 1, "rotation": 30})
    i2 = msp.add_blockref("LEAF", (0, 50), dxfattribs={"layer": "WALLS", "xscale": -1})
    i3 = msp.add_blockref("LEAF", (0, 100), dxfattribs={"color": 6})
    i3.grid(size=(2, 3), spacing=(4, 5))
    i5 = msp.add_blockref("LEAF", (60, 60), dxfattribs={"extrusion": (0, 0, -1), "rotation": 15})
    inserts += [i1, i2, i3, i5]
    i4 = msp.add_blockref("LEAF", (50, 50), dxfattribs={"xscale": 2, "yscale": 1})

    # Expected geometry of every exploded entity (ezdxf's own block explosion).
    exploded: list = []
    for ins in inserts:
        expand_insert(ins, ins.dxf.handle, exploded)
    for h, topH, v in exploded:
        t = v.dxftype()
        if t in ("LINE", "CIRCLE", "ARC", "LWPOLYLINE"):
            exp.ent(v, insert=topH, handle=h, tol=1e-7)
        elif t == "TEXT":
            exp.text(v, "L", insert=topH, handle=h, tol=1e-7, full=False)

    # Colour / layer inheritance (AutoCAD rules) for selected entities.
    exp.prop(l_byblock.dxf.handle, insert=i2.dxf.handle, color=0x0000FF, layer="WALLS", lineweight=50, flags=FLAG_IN_BLOCK)
    exp.prop(c_bylayer.dxf.handle, insert=i2.dxf.handle, color=0x0000FF, layer="WALLS")
    exp.prop(a_walls.dxf.handle, insert=i2.dxf.handle, color=0x0000FF, layer="WALLS")
    exp.prop(l_red.dxf.handle, insert=i2.dxf.handle, color=0xFF0000)
    exp.prop(l_byblock.dxf.handle, insert=i3.dxf.handle, color=0xFF00FF, layer="0", count=6)
    exp.prop(c_bylayer.dxf.handle, insert=i3.dxf.handle, color=0xFFFFFF, layer="0", count=6)
    # In TOP (red, layer EQUIP): MID children with BYBLOCK resolve to red, layer-0 BYLAYER to EQUIP (green).
    exp.prop(l_mid.dxf.handle, insert=i1.dxf.handle, color=0xFF0000, layer="EQUIP", linetype="DASHED", count=2)
    exp.prop(l_byblock.dxf.handle, insert=i1.dxf.handle, layer="EQUIP", count=3)
    exp.prop(c_bylayer.dxf.handle, insert=i1.dxf.handle, color=0x00FF00, layer="EQUIP", count=3)
    exp.prop(p_top.dxf.handle, insert=i1.dxf.handle, color=0x00FF00, layer="EQUIP", count=1)
    # LEAF directly in TOP with colour BYLAYER on layer 0 → BYBLOCK children take EQUIP's colour (green):
    # 2 red instances through the BYBLOCK MID chain + 1 green instance.
    exp.data["colorCounts"] = [{"handle": l_byblock.dxf.handle, "insert": i1.dxf.handle, "colors": {"ff0000": 2, "ff00": 1}}]

    # Non-uniform scale: the circle becomes an ellipse through the transformed circle points.
    m = i4.matrix44()
    pts = [m.transform(Vec3(1 + 0.5 * math.cos(a), 1 + 0.5 * math.sin(a))) for a in [k * math.pi / 4 for k in range(8)]]
    exp.data["ellipsePoints"].append({"handle": c_bylayer.dxf.handle, "insert": i4.dxf.handle, "c": v2(m.transform(Vec3(1, 1))), "points": [v2(p) for p in pts], "tol": 1e-9})
    arc_pts = [m.transform(Vec3(math.cos(a), math.sin(a))) for a in [k * math.pi / 8 for k in range(5)]]
    exp.data["ellipsePoints"].append({"handle": a_walls.dxf.handle, "insert": i4.dxf.handle, "c": v2(m.transform(Vec3(0, 0))), "points": [v2(p) for p in arc_pts], "tol": 1e-9, "arc": True})

    # Attributes, one invisible.
    tagb = doc.blocks.new("TAGB")
    tagb.add_circle((0, 0), 2)
    tagb.add_attdef("TAG", (0, 3), dxfattribs={"height": 1})
    tagb.add_attdef("HIDDEN", (0, -3), dxfattribs={"height": 1, "flags": 1})
    ia = msp.add_blockref("TAGB", (200, 0), dxfattribs={"layer": "ANNO"})
    ia.add_auto_attribs({"TAG": "V-200", "HIDDEN": "secret"})
    for a in ia.attribs:
        exp.text(a, "V-200" if a.dxf.tag == "TAG" else "secret", insert=ia.dxf.handle, hidden=a.dxf.tag == "HIDDEN")

    # OCS (0, 0, -1) entities: X is mirrored.
    ocs_attrs = {"extrusion": (0, 0, -1)}
    for e in [
        msp.add_circle((10, 300), 4, dxfattribs=ocs_attrs),
        msp.add_arc((30, 300), 5, 10, 100, dxfattribs=ocs_attrs),
        msp.add_lwpolyline([(40, 300, 0, 0, 0.4), (50, 300, 0, 0, 0), (50, 310, 0, 0, 0)], format="xyseb", dxfattribs=ocs_attrs),
    ]:
        exp.ent(e)
    e = msp.add_text("OCS", height=2, dxfattribs=ocs_attrs).set_placement((60, 300))
    exp.text(e, "OCS", full=False)
    # Arbitrary extrusion (tilted plane): circle projects to an ellipse.
    tilt = (0.3, 0.4, 0.866)
    e = msp.add_circle((5, 5, 0), 10, dxfattribs={"extrusion": tilt})
    ocs = OCS(tilt)
    tp = [ocs.to_wcs(Vec3(5 + 10 * math.cos(a), 5 + 10 * math.sin(a), 0)) for a in [k * math.pi / 3 for k in range(6)]]
    exp.data["ellipsePoints"].append({"handle": e.dxf.handle, "insert": None, "c": v2(ocs.to_wcs(Vec3(5, 5, 0))), "points": [v2(p) for p in tp], "tol": 1e-9})

    # Cycle A → B → A must not hang.
    ca = doc.blocks.new("CYC_A")
    cb = doc.blocks.new("CYC_B")
    ca.add_line((0, 0), (1, 1))
    ca.add_blockref("CYC_B", (1, 0))
    cb.add_blockref("CYC_A", (1, 0))
    msp.add_blockref("CYC_A", (500, 500))

    mesh = msp.add_mesh()
    with mesh.edit_data() as md:
        md.vertices = [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)]
        md.faces = [(0, 1, 2, 3)]
    add_solid3d(msp)
    msp.add_wipeout([(0, 0), (1, 0), (1, 1)])

    dims: list = []
    d1 = msp.add_aligned_dim(p1=(0, 400), p2=(30, 420), distance=5)
    d1.render()
    d2 = msp.add_radius_dim(center=(60, 410), radius=8, angle=45)
    d2.render()
    for d in (d1, d2):
        expand_dimension(d.dimension, dims)
    for h, topH, v in dims:
        if v.dxftype() in ("LINE", "CIRCLE", "ARC"):
            exp.ent(v, insert=topH, handle=h, tol=1e-7)

    # Paper space layouts.
    lay1 = doc.layout("Layout1")
    lay1.add_line((0, 0), (297, 0))
    lay1.add_text("Layout one", height=5).set_placement((10, 10))
    lay2 = doc.layouts.new("Sheet2")
    lay2.add_circle((50, 50), 20)
    lay2.add_lwpolyline([(0, 0), (420, 0), (420, 297), (0, 297)], close=True)
    lay2.add_text("Sheet two", height=5).set_placement((10, 10))

    counts, skipped = split_counts({}, msp)
    exp["version"] = "AC1024"
    exp["insunits"] = 4
    exp["layouts"] = ["Model", "Layout1", "Sheet2"]
    exp["layers"] = layer_table(doc)
    exp["counts"] = counts
    # The cyclic INSERT itself is imported; its recursive inner reference is skipped once per definition.
    exp["skipped"] = {**skipped, "INSERT": 1}
    exp["inserts"] = sum(1 for e in msp if e.dxftype() in ("INSERT", "DIMENSION"))
    exp["layoutCounts"] = {
        "Layout1": {k: v for k, v in split_counts({}, lay1)[0].items()},
        "Sheet2": {k: v for k, v in split_counts({}, lay2)[0].items()},
    }
    exp["layoutSkipped"] = {"Layout1": split_counts({}, lay1)[1], "Sheet2": split_counts({}, lay2)[1]}
    exp["warningsContain"] = ["CYC_A", "MESH", "WIPEOUT", "3DSOLID"]
    save(doc, "r2010_blocks.dxf", exp)
    expectations.append(exp.data)


# --------------------------------------------------------------------------------------------
# Fixture: R2018 (AC1032) plot plan in metres with UTM-sized coordinates


def make_plot_plan(expectations: list):
    doc = ezdxf.new("R2018", setup=True)
    doc.units = units.M
    msp = doc.modelspace()
    exp = Expect("r2018_plotplan.dxf")
    X0, Y0 = 600000.0, 2500000.0
    doc.layers.add("GRID", color=8, linetype="CENTER")
    doc.layers.add("GRID_TEXT", color=7)
    doc.layers.add("EQUIPMENT", color=4)
    doc.layers.add("TANKS", color=6)
    doc.layers.add("BUND", color=30)
    doc.layers.add("ROADS", color=9)
    doc.layers.add("HAZARD", color=1)
    doc.layers.add("ANNOTATION", color=2)
    tcl = doc.layers.add("TRUECOLOR", color=3)
    tcl.rgb = (10, 20, 30)
    tcl.dxf.lineweight = 50

    # Grid every 50 m with labels.
    for k in range(7):
        x = X0 + 50 * k
        e = msp.add_line((x, Y0 - 10), (x, Y0 + 210), dxfattribs={"layer": "GRID"})
        if k in (0, 3):
            exp.ent(e, color=0x808080, layer="GRID", linetype="CENTER")
        t = msp.add_text(f"E {x:.0f}", height=2.5, rotation=90, dxfattribs={"layer": "GRID_TEXT"}).set_placement(
            (x, Y0 - 12), align=TextEntityAlignment.MIDDLE_RIGHT
        )
        if k == 1:
            exp.text(t, f"E {x:.0f}")
    for k in range(5):
        y = Y0 + 50 * k
        e = msp.add_line((X0 - 10, y), (X0 + 310, y), dxfattribs={"layer": "GRID"})
        if k == 4:
            exp.ent(e)
        t = msp.add_text(f"N {y:.0f}", height=2.5, dxfattribs={"layer": "GRID_TEXT"}).set_placement(
            (X0 - 12, y), align=TextEntityAlignment.MIDDLE_RIGHT
        )
        if k == 2:
            exp.text(t, f"N {y:.0f}")

    # Equipment: pumps (exact UTM coordinates).
    for i, (x, y) in enumerate([(600123.456, 2500087.125), (600126.789, 2500087.125), (600130.0625, 2500087.125)]):
        e = msp.add_circle((x, y), 0.75, dxfattribs={"layer": "EQUIPMENT"})
        exp.ent(e, color=0x00FFFF, layer="EQUIPMENT")
        t = msp.add_text(f"P-10{i + 1}", height=0.5, dxfattribs={"layer": "ANNOTATION"}).set_placement(
            (x, y - 1.5), align=TextEntityAlignment.TOP_CENTER
        )
        exp.text(t, f"P-10{i + 1}")

    # Tanks: shell circles + square outline with rounded corners.
    tanks = [(600200.0, 2500150.0, 15.0), (600250.0, 2500150.0, 20.0)]
    for cx, cy, r in tanks:
        e = msp.add_circle((cx, cy), r, dxfattribs={"layer": "TANKS"})
        exp.ent(e, color=0xFF00FF)
        msp.add_circle((cx, cy), r - 0.5, dxfattribs={"layer": "TANKS"})
    # Bund: separate LINEs around both tanks with 0.05 m gaps at the corners.
    bx0, by0, bx1, by1 = 600175.0, 2500120.0, 600280.0, 2500180.0
    gap = 0.05
    bund = [
        ((bx0 + gap, by0), (bx1 - gap, by0)),
        ((bx1, by0 + gap), (bx1, by1 - gap)),
        ((bx1 - gap, by1), (bx0 + gap, by1)),
        ((bx0, by1 - gap), (bx0, by0 + gap)),
    ]
    for p, q in bund:
        e = msp.add_line(p, q, dxfattribs={"layer": "BUND"})
        exp.ent(e, color=0xFF7F00, layer="BUND")
    # Tank outline polyline with rounded corners (bulges).
    e = msp.add_lwpolyline(
        [(600180, 2500125, 0, 0, 0), (600220, 2500125, 0, 0, 0.41421356237), (600225, 2500130, 0, 0, 0),
         (600225, 2500170, 0, 0, 0.41421356237), (600220, 2500175, 0, 0, 0), (600180, 2500175, 0, 0, 0)],
        format="xyseb", close=True, dxfattribs={"layer": "TANKS"},
    )
    exp.ent(e)

    # Roads: centre line and edges as LWPOLYLINEs (with a curve).
    for off in (-4.0, 0.0, 4.0):
        e = msp.add_lwpolyline(
            [(X0 - 5, Y0 + 100 + off, 0, 0, 0), (X0 + 150, Y0 + 100 + off, 0, 0, 0.2), (X0 + 160 - off * 0.2, Y0 + 110 + off, 0, 0, 0),
             (X0 + 300, Y0 + 110 + off, 0, 0, 0)],
            format="xyseb", dxfattribs={"layer": "ROADS", "linetype": "DASHED" if off == 0 else "BYLAYER"},
        )
        if off == 0:
            exp.ent(e, color=0xC0C0C0, linetype="DASHED")

    # Hazard zone: Arabic labels, specials, pattern hatch.
    e = msp.add_mtext(ARABIC, dxfattribs={"layer": "HAZARD", "char_height": 3, "insert": (600060.5, 2500030.25), "attachment_point": 5})
    exp.text(e, ARABIC)
    exp.prop(e.dxf.handle, color=0xFF0000, layer="HAZARD")
    e = msp.add_text(ARABIC, height=2, dxfattribs={"layer": "HAZARD"}).set_placement((600060.5, 2500020.0), align=TextEntityAlignment.BOTTOM_CENTER)
    exp.text(e, ARABIC)
    e = msp.add_text("%%c600 PIPE 45%%d %%p0.010", height=1, dxfattribs={"layer": "ANNOTATION"}).set_placement((600100.0, 2500010.0))
    exp.text(e, "Ø600 PIPE 45° ±0.010")
    h = msp.add_hatch(color=1, dxfattribs={"layer": "HAZARD"})
    h.set_pattern_fill("ANSI31", scale=2.0)
    h.paths.add_polyline_path([(600040, 2500010), (600080, 2500010), (600080, 2500040), (600040, 2500040)], is_closed=True)
    exp.data["hatches"].append(hatch_expect(h))
    h = msp.add_hatch(color=1, dxfattribs={"layer": "HAZARD"})
    h.paths.add_polyline_path([(600090, 2500010), (600095, 2500010), (600095, 2500015, 0.5)], is_closed=True)
    exp.data["hatches"].append(hatch_expect(h))

    # True colour on layer and entity.
    e = msp.add_line((X0, Y0 - 5), (X0 + 10, Y0 - 5), dxfattribs={"layer": "TRUECOLOR"})
    exp.ent(e, color=0x0A141E, lineweight=50, layer="TRUECOLOR")
    e = msp.add_line((X0, Y0 - 6), (X0 + 10, Y0 - 6), dxfattribs={"layer": "TRUECOLOR", "lineweight": 13})
    e.rgb = (1, 2, 3)
    exp.ent(e, color=0x010203, lineweight=13)

    # Paper space title block.
    psp = doc.layout("Layout1")
    psp.add_lwpolyline([(0, 0), (420, 0), (420, 297), (0, 297)], close=True)
    psp.add_line((300, 0), (300, 40))
    psp.add_text("PLOT PLAN", height=5).set_placement((310, 20))
    psp.add_mtext(ARABIC, dxfattribs={"char_height": 4, "insert": (310, 10)})

    counts, skipped = split_counts({}, msp)
    exp["version"] = "AC1032"
    exp["insunits"] = 6
    exp["layouts"] = ["Model", "Layout1"]
    exp["layers"] = layer_table(doc)
    exp["counts"] = counts
    exp["skipped"] = skipped
    # Extents come from entity bounds (text bounds are estimated): they must cover the grid and stay close to it.
    exp["extentsContain"] = [X0 - 10, Y0 - 10, X0 + 310, Y0 + 210]
    exp["extentsWithin"] = [X0 - 60, Y0 - 60, X0 + 320, Y0 + 220]
    exp["layoutCounts"] = {"Layout1": split_counts({}, psp)[0]}
    save(doc, "r2018_plotplan.dxf", exp)
    expectations.append(exp.data)

    exp_bin = Expect("r2018_plotplan_binary.dxf")
    exp_bin.data.update({k: v for k, v in exp.data.items() if k != "file"})
    exp_bin["sameAs"] = "r2018_plotplan.dxf"
    save(doc, "r2018_plotplan_binary.dxf", exp_bin, fmt="bin")
    expectations.append(exp_bin.data)


# --------------------------------------------------------------------------------------------
# Fixture: R2013 (AC1027) mechanical drawing in millimetres


def make_mm(expectations: list):
    doc = ezdxf.new("R2013", setup=True)
    doc.units = units.MM
    msp = doc.modelspace()
    exp = Expect("mm_flange.dxf")
    doc.layers.add("OUTLINE", color=7)
    doc.layers.add("CENTER", color=1, linetype="CENTER")
    e = msp.add_circle((0, 0), 150, dxfattribs={"layer": "OUTLINE"})
    exp.ent(e)
    e = msp.add_circle((0, 0), 60.3, dxfattribs={"layer": "OUTLINE"})
    exp.ent(e)
    for k in range(8):
        a = k * math.pi / 4
        e = msp.add_circle((110 * math.cos(a), 110 * math.sin(a)), 11, dxfattribs={"layer": "OUTLINE"})
        if k == 1:
            exp.ent(e)
    e = msp.add_circle((0, 0), 110, dxfattribs={"layer": "CENTER"})
    exp.ent(e, color=0xFF0000, linetype="CENTER")
    e = msp.add_arc((0, 0), 130, 200, 340, dxfattribs={"layer": "OUTLINE"})
    exp.ent(e)
    d = msp.add_diameter_dim(center=(0, 0), radius=150, angle=30)
    d.render()
    d = msp.add_linear_dim(base=(0, 180), p1=(-150, 0), p2=(150, 0))
    d.render()
    counts, skipped = split_counts({}, msp)
    exp["version"] = "AC1027"
    exp["insunits"] = 4
    exp["layouts"] = ["Model", "Layout1"]
    exp["layers"] = layer_table(doc)
    exp["counts"] = counts
    exp["skipped"] = skipped
    save(doc, "mm_flange.dxf", exp)
    expectations.append(exp.data)


# --------------------------------------------------------------------------------------------
# Fixture: R2018 tracing site (rows 49–53) at UTM coordinates, in metres


def make_trace_site(expectations: list):
    doc = ezdxf.new("R2018", setup=True)
    doc.units = units.M
    msp = doc.modelspace()
    exp = Expect("r2018_trace_site.dxf")
    X0, Y0 = 600000.0, 2500000.0
    doc.layers.add("BUILDING", color=7)
    doc.layers.add("BUND", color=30)
    doc.layers.add("TANKS", color=6)
    doc.layers.add("PAVING", color=8)
    doc.layers.add("EQUIPMENT", color=4)

    def P(x, y):
        return (X0 + x, Y0 + y)

    # Building A: L-shaped outline drawn as separate LINEs (some reversed) with exact shared
    # endpoints, plus a partition wall from (30, 10) to (30, 40) that splits the bottom and top
    # walls → junctions for chain tracing (Tab / Enter).
    walls = [
        ((10, 10), (30, 10)),
        ((50, 10), (30, 10)),  # reversed
        ((50, 10), (50, 25)),
        ((35, 25), (50, 25)),  # reversed
        ((35, 25), (35, 40)),
        ((35, 40), (30, 40)),
        ((10, 40), (30, 40)),  # reversed
        ((10, 40), (10, 10)),
        ((30, 10), (30, 40)),  # partition
    ]
    for a, b in walls:
        e = msp.add_line(P(*a), P(*b), dxfattribs={"layer": "BUILDING"})
        exp.ent(e, layer="BUILDING")

    # Building B: rectangle of four LINEs with 5 cm gaps at every corner.
    gap = 0.05
    bx0, by0, bx1, by1 = 70.0, 10.0, 100.0, 30.0
    for a, b in [
        ((bx0 + gap, by0), (bx1 - gap, by0)),
        ((bx1, by0 + gap), (bx1, by1 - gap)),
        ((bx1 - gap, by1), (bx0 + gap, by1)),
        ((bx0, by1 - gap), (bx0, by0 + gap)),
    ]:
        e = msp.add_line(P(*a), P(*b), dxfattribs={"layer": "BUILDING"})
        exp.ent(e)

    # Bund: separate LINEs with 5 cm gaps around a tank (circle with an exact centre and radius).
    ux0, uy0, ux1, uy1 = 10.0, 60.0, 60.0, 100.0
    for a, b in [
        ((ux0 + gap, uy0), (ux1 - gap, uy0)),
        ((ux1, uy0 + gap), (ux1, uy1 - gap)),
        ((ux1 - gap, uy1), (ux0 + gap, uy1)),
        ((ux0, uy1 - gap), (ux0, uy0 + gap)),
    ]:
        e = msp.add_line(P(*a), P(*b), dxfattribs={"layer": "BUND"})
        exp.ent(e, layer="BUND")
    e = msp.add_circle(P(35.125, 80.375), 12.5, dxfattribs={"layer": "TANKS"})
    exp.ent(e, layer="TANKS")

    # Solid hatch with an arc edge (hatch boundary pick).
    h = msp.add_hatch(color=8, dxfattribs={"layer": "PAVING"})
    h.paths.add_polyline_path([(*P(70, 60), 0), (*P(100, 60), 0), (*P(100, 75), 0.4), (*P(70, 75), 0)], is_closed=True)
    exp.data["hatches"].append(hatch_expect(h))

    # Closed LWPOLYLINE with rounded corners (bulges).
    e = msp.add_lwpolyline(
        [(*P(72, 90), 0, 0, 0), (*P(98, 90), 0, 0, 0.41421356237), (*P(100, 92), 0, 0, 0),
         (*P(100, 103), 0, 0, 0.41421356237), (*P(98, 105), 0, 0, 0), (*P(72, 105), 0, 0, 0.41421356237),
         (*P(70, 103), 0, 0, 0), (*P(70, 92), 0, 0, 0.41421356237)],
        format="xyseb", close=True, dxfattribs={"layer": "PAVING"},
    )
    exp.ent(e)

    # Ellipse (full) and an elliptic arc.
    e = msp.add_ellipse(P(130, 20), major_axis=(10, 0, 0), ratio=0.5, dxfattribs={"layer": "EQUIPMENT"})
    exp.ent(e)
    e = msp.add_ellipse(P(130, 50), major_axis=(0, 8, 0), ratio=0.5, start_param=0, end_param=math.pi,
                        dxfattribs={"layer": "EQUIPMENT"})
    exp.ent(e)

    # Block PUMP: skid outline (four LINEs) and a motor circle; inserted rotated and scaled.
    blk = doc.blocks.new("PUMP")
    for a, b in [((-2, -1), (2, -1)), ((2, -1), (2, 1)), ((2, 1), (-2, 1)), ((-2, 1), (-2, -1))]:
        blk.add_line(a, b, dxfattribs={"layer": "0"})
    blk.add_circle((0.5, 0), 0.75, dxfattribs={"layer": "0"})
    ins = msp.add_blockref("PUMP", P(130, 85), dxfattribs={"layer": "EQUIPMENT", "rotation": 30, "xscale": 1.5, "yscale": 1.5})
    exploded: list = []
    expand_insert(ins, ins.dxf.handle, exploded)
    for hnd, top, v in exploded:
        exp.ent(v, insert=top, handle=hnd, tol=1e-7)

    counts, skipped = split_counts({}, msp)
    exp["version"] = "AC1032"
    exp["insunits"] = 6
    exp["layouts"] = ["Model", "Layout1"]
    exp["layers"] = layer_table(doc)
    exp["counts"] = counts
    exp["skipped"] = skipped
    exp["inserts"] = 1
    save(doc, "r2018_trace_site.dxf", exp)
    expectations.append(exp.data)


# --------------------------------------------------------------------------------------------
# Fixture: malformed DXF (invalid group code) → readable error with line number


def make_malformed(expectations: list):
    src = (OUT / "mm_flange.dxf").read_text(encoding="utf-8").splitlines()
    # Find the first LINE/CIRCLE entity in the ENTITIES section and corrupt one of its group codes.
    start = src.index("ENTITIES")
    idx = next(i for i in range(start, len(src)) if src[i].strip() == "CIRCLE")
    bad = idx + 1  # first group code line of the CIRCLE
    while src[bad].strip() != "8":
        bad += 2
    src[bad] = "  8x"  # layer group code corrupted
    (OUT / "malformed.dxf").write_text("\n".join(src) + "\n", encoding="utf-8")
    expectations.append({"file": "malformed.dxf", "error": {"line": bad + 1, "contains": "8x"}})


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    expectations: list = []
    make_r12(expectations)
    make_r2000(expectations)
    make_r2010(expectations)
    make_plot_plan(expectations)
    make_mm(expectations)
    make_trace_site(expectations)
    make_malformed(expectations)
    exp_path = OUT / "expectations.json"
    exp_path.write_text(json.dumps({"ezdxf": ezdxf.__version__, "files": expectations}, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    # Keep the JSON in the repository's Prettier style (best effort: needs node_modules).
    try:
        subprocess.run(["npx", "prettier", "--ignore-path", "", "--write", str(exp_path)], cwd=ROOT, check=True, capture_output=True)
    except (OSError, subprocess.CalledProcessError) as exc:
        print(f"note: prettier not run on expectations.json ({exc})")
    total = sum(p.stat().st_size for p in OUT.iterdir())
    print(f"wrote {len(list(OUT.iterdir()))} files, {total / 1024:.0f} KiB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
