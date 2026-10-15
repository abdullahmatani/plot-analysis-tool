import type { ReactNode } from 'react';

import { effectiveShortcut, formatShortcut, getCommand } from '@/app/commands';
import { Kbd } from '@/components/ui/kbd';

/**
 * Offline help content (row 86). Command references render the live title and shortcut from the
 * command registry, so the guides stay correct when shortcuts are customised.
 */

export function Cmd({ id, children }: { id: string; children?: ReactNode }) {
  const c = getCommand(id);
  const sc = c ? effectiveShortcut(c) : undefined;
  return (
    <span className="whitespace-nowrap">
      <strong className="font-medium">{children ?? (c ? `${c.menu} → ${c.title}` : id)}</strong>
      {sc && (
        <>
          {' '}
          <Kbd>{formatShortcut(sc)}</Kbd>
        </>
      )}
    </span>
  );
}

export interface HelpTopic {
  id: string;
  title: string;
  keywords: string;
  body: ReactNode;
}

export const QUICK_START: HelpTopic[] = [
  {
    id: 'start',
    title: 'Getting started',
    keywords: 'new project open import drawing',
    body: (
      <ol className="list-decimal space-y-1.5 pl-5">
        <li>
          Create a project (<Cmd id="file.new" />) or open a recent one from the start screen.
        </li>
        <li>
          Import a plot plan: drag a DXF, DWG or PDF onto the canvas, or use <Cmd id="file.importDrawing" />.
          Files are read on this computer only.
        </li>
        <li>
          Navigate: mouse wheel (or pinch) zooms at the cursor, middle button, Space+drag or one finger pans,{' '}
          <Cmd id="view.zoomExtents" /> shows everything and <Cmd id="view.zoomSelection" /> the selection.
          Keep views you return to with <Cmd id="view.saveView" /> (<Cmd id="view.manageViews" /> lists them).
        </li>
        <li>
          Set the scale before measuring (calibration); the status bar shows whether the drawing is
          calibrated.
        </li>
        <li>
          Draw, trace and offset analysis objects on analysis layers (Layers tab); style and label them.
        </li>
        <li>Export a true-scale PDF, PNG, SVG, DXF or a table (Export menu).</li>
      </ol>
    ),
  },
  {
    id: 'saving',
    title: 'Saving and recovery',
    keywords: 'autosave save file restore point crash recover undo history',
    body: (
      <div className="space-y-2">
        <p>
          Every change is saved automatically in this browser within a second; the badge in the status bar
          shows “Saved locally”. Undo history is kept across reloads.
        </p>
        <p>
          Use <Cmd id="file.save" /> to keep a <code>.patproj</code> file (it includes the source drawings) —
          browser storage can be cleared by the browser or an administrator. When linked to a file, the file
          is updated automatically too.
        </p>
        <p>
          <Cmd id="file.restorePoint" /> creates a named restore point; <Cmd id="file.history" /> lists
          restore points, which can be previewed and restored (undoable). After a crash, the start screen
          offers to recover the project including unfinished drawing operations.
        </p>
      </div>
    ),
  },
  {
    id: 'privacy',
    title: 'Offline and privacy',
    keywords: 'offline network privacy upload internet security air-gapped',
    body: (
      <div className="space-y-2">
        <p>
          The application makes no network requests: drawings, tables and projects never leave this computer.
          A strict Content-Security-Policy blocks connections to any other host, and the automated test suite
          fails if any request leaves the app’s own origin.
        </p>
        <p>
          After the first load the app works fully offline (installable as an app). On computers without
          internet access, run it from the offline bundle (see the bundle’s README.txt).
        </p>
      </div>
    ),
  },
  {
    id: 'troubleshooting',
    title: 'Troubleshooting',
    keywords: 'dwg error import failed text font slow storage full',
    body: (
      <ul className="list-disc space-y-1.5 pl-5">
        <li>
          <strong>A DWG does not open:</strong> the import report explains why. Export the drawing from your
          CAD application as DXF (any version) or plot it to PDF and import that instead.
        </li>
        <li>
          <strong>Text looks different from CAD:</strong> SHX/TrueType fonts are replaced by bundled fonts —
          see <Cmd id="help.cadFonts" />.
        </li>
        <li>
          <strong>Storage full:</strong> save the project to a file immediately (nothing is lost), then free
          space in <Cmd id="help.storage" />.
        </li>
        <li>
          <strong>Slow on very large drawings:</strong> hide unneeded source layers (Layers tab) and use ghost
          mode; make sure hardware acceleration is enabled in the browser.
        </li>
      </ul>
    ),
  },
];
