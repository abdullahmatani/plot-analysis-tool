import { Magnet, Grid3x3, Ruler } from 'lucide-react';

import { registerCommands } from '@/app/commands';
import { canvasController, registerOverlay, setSnapper } from '@/render/canvas-controller';
import { getProject } from '@/store/project';
import { useViewStore } from '@/store/view';
import type { SnapResult } from '@/tools/types';

import { computeSnap, constrain, gridSnap, type SnapSettings } from './engine';

let lastSnap: { screen: { x: number; y: number }; snap: SnapResult } | null = null;

export function snapSettings(): SnapSettings {
  const v = useViewStore.getState();
  return {
    enabled: v.snapEnabled,
    modes: new Set(v.snapModes),
    ortho: v.ortho,
    polar: v.polar,
    polarIncrementDeg: v.polarIncrementDeg,
    gridSnap: v.gridSnap,
    gridSize: v.gridSize,
    radiusPx: 10,
    viewRotation: v.view.rotation,
  };
}

/** Objects currently being edited are excluded from snapping (set by edit tools). */
export const snapExclusions = new Set<string>();

export function register() {
  setSnapper((_screen, world, frame, base, e) => {
    const project = getProject();
    lastSnap = null;
    if (!project) return { pt: world, snap: null };
    const s = snapSettings();
    // Holding Alt temporarily suspends object snaps.
    const snap = e?.altKey
      ? null
      : computeSnap({ project, world, scale: frame.scale, base, settings: s, exclude: snapExclusions });
    if (snap) {
      lastSnap = { screen: frame.toScreen(snap.pt), snap };
      return { pt: snap.pt, snap };
    }
    const c = constrain(world, base, s);
    if (c) {
      const snapR: SnapResult = { pt: c.pt, mode: c.mode };
      lastSnap = { screen: frame.toScreen(c.pt), snap: snapR };
      return { pt: c.pt, snap: snapR };
    }
    if (s.gridSnap && s.gridSize > 0) {
      const g = gridSnap(world, s.gridSize);
      const snapR: SnapResult = { pt: g, mode: 'grid', source: { kind: 'grid' } };
      lastSnap = { screen: frame.toScreen(g), snap: snapR };
      return { pt: g, snap: snapR };
    }
    return { pt: world, snap: null };
  });

  const unOverlay = registerOverlay(90, (g) => {
    const lp = canvasController()?.lastPointer;
    if (!lastSnap || !lp?.snap) return;
    const { x, y } = lastSnap.screen;
    const mode = lastSnap.snap.mode;
    g.strokeStyle = '#22c55e';
    g.fillStyle = '#22c55e';
    g.lineWidth = 2;
    g.beginPath();
    const s = 6;
    switch (mode) {
      case 'endpoint':
      case 'anchor':
        g.rect(x - s, y - s, 2 * s, 2 * s);
        break;
      case 'midpoint':
        g.moveTo(x, y - s);
        g.lineTo(x + s, y + s);
        g.lineTo(x - s, y + s);
        g.closePath();
        break;
      case 'centre':
        g.arc(x, y, s, 0, Math.PI * 2);
        break;
      case 'quadrant':
        g.moveTo(x, y - s);
        g.lineTo(x + s, y);
        g.lineTo(x, y + s);
        g.lineTo(x - s, y);
        g.closePath();
        break;
      case 'intersection':
        g.moveTo(x - s, y - s);
        g.lineTo(x + s, y + s);
        g.moveTo(x + s, y - s);
        g.lineTo(x - s, y + s);
        break;
      case 'perpendicular':
        g.moveTo(x - s, y + s);
        g.lineTo(x + s, y + s);
        g.moveTo(x - s, y + s);
        g.lineTo(x - s, y - s);
        g.moveTo(x - s, y);
        g.lineTo(x, y);
        g.lineTo(x, y + s);
        break;
      case 'tangent':
        g.arc(x, y, s * 0.7, 0, Math.PI * 2);
        g.moveTo(x - s, y - s);
        g.lineTo(x + s, y - s);
        break;
      case 'nearest':
        g.moveTo(x - s, y - s);
        g.lineTo(x + s, y - s);
        g.lineTo(x - s, y + s);
        g.lineTo(x + s, y + s);
        g.closePath();
        break;
      default:
        g.moveTo(x - s, y);
        g.lineTo(x + s, y);
        g.moveTo(x, y - s);
        g.lineTo(x, y + s);
    }
    g.stroke();
    g.font = '11px Inter Variable, sans-serif';
    const label = mode === 'anchor' ? 'Anchor' : mode[0].toUpperCase() + mode.slice(1);
    const tw = g.measureText(label).width;
    g.fillStyle = 'rgba(15,23,42,0.85)';
    g.fillRect(x + 10, y + 8, tw + 8, 16);
    g.fillStyle = '#f8fafc';
    g.fillText(label, x + 14, y + 20);
  });

  const toggle = (key: 'snapEnabled' | 'ortho' | 'polar' | 'gridSnap') => () => {
    const v = useViewStore.getState();
    const next = !v[key];
    if (key === 'ortho' && next) v.set({ ortho: true, polar: false });
    else if (key === 'polar' && next) v.set({ polar: true, ortho: false });
    else v.set({ [key]: next } as never);
  };
  const unCmds = registerCommands([
    {
      id: 'snap.toggle',
      title: 'Toggle object snap',
      menu: 'View',
      section: 'snap',
      shortcut: 'F3',
      icon: Magnet,
      checked: () => useViewStore.getState().snapEnabled,
      run: toggle('snapEnabled'),
    },
    {
      id: 'snap.ortho',
      title: 'Toggle ortho',
      menu: 'View',
      section: 'snap',
      shortcut: 'F8',
      icon: Ruler,
      checked: () => useViewStore.getState().ortho,
      run: toggle('ortho'),
    },
    {
      id: 'snap.polar',
      title: 'Toggle polar tracking',
      menu: 'View',
      section: 'snap',
      shortcut: 'F10',
      checked: () => useViewStore.getState().polar,
      run: toggle('polar'),
    },
    {
      id: 'snap.grid',
      title: 'Toggle grid snap',
      menu: 'View',
      section: 'snap',
      shortcut: 'F9',
      icon: Grid3x3,
      checked: () => useViewStore.getState().gridSnap,
      run: toggle('gridSnap'),
    },
  ]);
  return () => {
    setSnapper(null);
    unOverlay();
    unCmds();
  };
}
