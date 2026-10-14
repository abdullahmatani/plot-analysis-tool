#!/usr/bin/env python3
"""Dev-only DXF validation helper for src/export/dxf-writer.ts (row 79).

Loads each DXF with ezdxf's recover module and runs a full audit. Prints a JSON summary per file
and exits non-zero if any file has load errors or audit errors. Audit *fixes* are reported too:
AutoCAD would apply the same repairs silently, but a clean writer should not need any.

Usage:
    python -m venv .venv && .venv/bin/pip install ezdxf
    .venv/bin/python scripts/validate-dxf.py out.dxf [more.dxf ...]
"""

import json
import sys


def validate(path: str) -> dict:
    from ezdxf import recover

    doc, auditor = recover.readfile(path)
    load_errors = [str(e.message) for e in auditor.errors]
    load_fixes = [str(f.message) for f in auditor.fixes]
    audit = doc.audit()
    msp = doc.modelspace()
    counts: dict = {}
    for e in msp:
        counts[e.dxftype()] = counts.get(e.dxftype(), 0) + 1
    return {
        "file": path,
        "dxfversion": doc.dxfversion,
        "encoding": doc.encoding,
        "load_errors": load_errors,
        "load_fixes": load_fixes,
        "audit_errors": [str(e.message) for e in audit.errors],
        "audit_fixes": [str(f.message) for f in audit.fixes],
        "layers": sorted(layer.dxf.name for layer in doc.layers),
        "linetypes": sorted(lt.dxf.name for lt in doc.linetypes),
        "styles": sorted(st.dxf.name for st in doc.styles),
        "entities": counts,
        "layouts": doc.layouts.names(),
    }


def main(argv: list) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 2
    ok = True
    for path in argv[1:]:
        result = validate(path)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        if result["load_errors"] or result["audit_errors"]:
            ok = False
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
