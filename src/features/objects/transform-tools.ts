import { toast } from 'sonner';
import { Move, Copy, RotateCw, Scaling, FlipHorizontal2 } from 'lucide-react';

import type { Geometry, Pt } from '@/core/types';
import { degToRad } from '@/core/units';
import { mirrorGeometry, rotateGeometry, scaleGeometry, translateGeometry } from '@/geometry/convert';
import { getProject } from '@/store/project';
import { setTool } from '@/tools/registry';
import { snapExclusions } from '@/features/snap/register';
import { createPickTool, type PickToolSpec } from '@/features/draw/pick-tool';

import { editableSelection, mirrorObjects, moveObjects, rotateObjects, scaleObjects } from './ops';

/** Interactive transforms of the selection (row 43): move, copy, rotate, scale, mirror. Snaps and typed values apply. */

function selectedGeoms(): Geometry[] {
  const p = getProject();
  const ids = new Set(editableSelection());
  return p ? p.objects.filter((o) => ids.has(o.id)).map((o) => o.geometry) : [];
}

const angleOf = (a: Pt, b: Pt) => Math.atan2(b.y - a.y, b.x - a.x);

function guard(): boolean {
  const ids = editableSelection();
  if (!ids.length) {
    toast.info('Select one or more objects first (locked layers cannot be edited).');
    setTimeout(() => setTool('select'), 0);
    return false;
  }
  snapExclusions.clear();
  ids.forEach((id) => snapExclusions.add(id));
  return true;
}

const withGuard = (spec: PickToolSpec & { shortcut?: string }): PickToolSpec & { shortcut?: string } => spec;

export const TRANSFORM_TOOLS: (PickToolSpec & { shortcut?: string })[] = [
  withGuard({
    id: 'edit.move',
    title: 'Move selection',
    icon: Move,
    shortcut: 'M',
    minPoints: 2,
    maxPoints: 2,
    prompt: (n) => (n === 0 ? 'Move: base point' : 'Move: destination (or type @dx,dy or a distance)'),
    preview: (pts, c) =>
      pts.length && c
        ? selectedGeoms().map((g) => translateGeometry(g, c.x - pts[0].x, c.y - pts[0].y))
        : null,
    finish: (pts) => {
      moveObjects(editableSelection(), pts[1].x - pts[0].x, pts[1].y - pts[0].y);
    },
  }),
  withGuard({
    id: 'edit.copy',
    title: 'Copy selection',
    icon: Copy,
    minPoints: 2,
    maxPoints: 2,
    prompt: (n) => (n === 0 ? 'Copy: base point' : 'Copy: destination (or type @dx,dy or a distance)'),
    preview: (pts, c) =>
      pts.length && c
        ? selectedGeoms().map((g) => translateGeometry(g, c.x - pts[0].x, c.y - pts[0].y))
        : null,
    finish: (pts) => {
      moveObjects(editableSelection(), pts[1].x - pts[0].x, pts[1].y - pts[0].y, true);
    },
  }),
  withGuard({
    id: 'edit.rotate',
    title: 'Rotate selection',
    icon: RotateCw,
    minPoints: 2,
    maxPoints: 2,
    prompt: (n) => (n === 0 ? 'Rotate: centre point' : 'Rotate: angle (pick, or type degrees anticlockwise)'),
    preview: (pts, c) =>
      pts.length && c ? selectedGeoms().map((g) => rotateGeometry(g, angleOf(pts[0], c), pts[0])) : null,
    typed: (v, pts) => {
      if (pts.length !== 1) return null;
      const deg = Number(v.replace(',', '.').replace(/°$/, ''));
      if (!Number.isFinite(deg)) return null;
      const a = degToRad(deg);
      return { x: pts[0].x + Math.cos(a), y: pts[0].y + Math.sin(a) };
    },
    finish: (pts) => {
      rotateObjects(editableSelection(), angleOf(pts[0], pts[1]), pts[0]);
    },
  }),
  withGuard({
    id: 'edit.scale',
    title: 'Scale selection',
    icon: Scaling,
    minPoints: 3,
    maxPoints: 3,
    prompt: (n) =>
      [
        'Scale: base point',
        'Scale: reference point (or type a factor)',
        'Scale: new position of the reference point',
      ][n] ?? '',
    preview: (pts, c) => {
      if (pts.length !== 2 || !c) return null;
      const k =
        Math.hypot(c.x - pts[0].x, c.y - pts[0].y) /
        (Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) || 1);
      return selectedGeoms().map((g) => scaleGeometry(g, k, pts[0]));
    },
    typed: (v, pts) => {
      const k = Number(v.replace(',', '.'));
      if (pts.length !== 1 || !(k > 0)) return null;
      scaleObjects(editableSelection(), k, pts[0]);
      return 'finish';
    },
    finish: (pts) => {
      if (pts.length < 3) return true;
      const k =
        Math.hypot(pts[2].x - pts[0].x, pts[2].y - pts[0].y) /
        (Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) || 1);
      scaleObjects(editableSelection(), k, pts[0]);
    },
  }),
  withGuard({
    id: 'edit.mirror',
    title: 'Mirror selection',
    icon: FlipHorizontal2,
    minPoints: 2,
    maxPoints: 2,
    prompt: (n) =>
      n === 0
        ? 'Mirror: first point of the mirror line'
        : 'Mirror: second point (hold Ctrl to keep the originals)',
    preview: (pts, c) => (pts.length && c ? selectedGeoms().map((g) => mirrorGeometry(g, pts[0], c)) : null),
    finish: (pts) => {
      mirrorObjects(editableSelection(), pts[0], pts[1], mirrorKeep);
    },
    key: (e) => {
      mirrorKeep = e.ctrlKey || e.metaKey;
      return null;
    },
  }),
];

let mirrorKeep = false;

export const transformTools = TRANSFORM_TOOLS.map((spec) => {
  const tool = createPickTool(spec);
  const activate = tool.activate;
  tool.activate = (ctx) => {
    activate?.(ctx);
    guard();
  };
  return { spec, tool };
});
