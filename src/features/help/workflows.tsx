import { Cmd, type HelpTopic } from './content';

/** Workflow guides W1–W4 (FDR §3), with live command names and shortcuts. */
export const WORKFLOWS: HelpTopic[] = [
  {
    id: 'w1',
    title: 'W1 — Consequence contours on a plot plan',
    keywords: 'contours consequence results table radiation overpressure dispersion anchors legend pdf',
    body: (
      <ol className="list-decimal space-y-1.5 pl-5">
        <li>
          Import the plot plan (PDF, DWG or DXF) with <Cmd id="file.importDrawing" />.
        </li>
        <li>
          Calibrate it with <Cmd id="calibration.calibrate" />. For a PDF with a stated scale (e.g. 1:500),
          choose “Ratio”. Otherwise pick two points on a known dimension, or use plant coordinates. Confirm
          with <Cmd id="calibration.check" />; the status bar badge then shows “Verified”.
        </li>
        <li>
          Place anchors on the release points (equipment centres, nozzles) with <Cmd id="anchors.place" />, or
          create them from circle centres with <Cmd id="anchors.fromCircles" />. Give each anchor the name
          used in your results table (e.g. “P-101”).
        </li>
        <li>
          Import the results table with <Cmd id="file.importTable" /> (CSV, TSV, XLSX), or paste a copied
          Excel range with <Cmd id="data.pasteTable" />. Check the preview and the header row.
        </li>
        <li>
          In the mapping step, choose the position (anchor name, or X/Y, or plant E/N), one or more size
          columns (e.g. 4, 12.5 and 37.5 kW/m²), whether sizes are radii or diameters, and their unit, and the
          label column. Rows with problems are listed by row number and skipped.
        </li>
        <li>
          In the Data tab, style the dataset by scenario: colour by a category column, or by value with class
          breaks. Each size column gets its own ring style and legend entry. Use a filter such as{' '}
          <code>category = &quot;Jet fire&quot;</code> to show a subset. Every change is one undo step.
        </li>
        <li>
          Check the legend in the Legend tab, then <Cmd id="export.dialog" />: choose A1, the scale (e.g.
          1:1000) and the title block, check the preview, and export a vector PDF. The calibration state is
          printed on the sheet.
        </li>
        <li>
          When updated results arrive, use <Cmd id="data.reimport" />. The mapping and styles are kept, and a
          summary lists the rows that were added, removed and changed.
        </li>
      </ol>
    ),
  },
  {
    id: 'w2',
    title: 'W2 — Separation-distance check',
    keywords: 'separation distance offset buffer equipment footprint trace measure',
    body: (
      <ol className="list-decimal space-y-1.5 pl-5">
        <li>Import and calibrate the plot plan (see W1, steps 1–2).</li>
        <li>
          Get the equipment footprint. <Cmd id="trace.pick" /> copies a line, polyline, circle or block
          outline exactly. <Cmd id="trace.chain" /> follows connected lines (Tab chooses the direction at
          junctions). <Cmd id="trace.boundary" /> finds the closed area around a point you click inside.{' '}
          <Cmd id="trace.manual" /> traces by hand with snapping.
        </li>
        <li>
          Select the footprint and run <Cmd id="offset.offset" />. Enter the required distance (e.g. 15 m, or
          −5 m to contract). Round corners (the default) mean “everything within the distance”; mitred corners
          give a square box. The offset stays linked to its source: edit the source or the distance and it
          updates. For several distances at once, use <Cmd id="offset.rings" />.
        </li>
        <li>
          Highlight and label the zone in the Properties panel: fill or hatch, line style, and a label
          template such as <code>{'{name} – {area} m²'}</code>.
        </li>
        <li>
          Measure to the nearest item with <Cmd id="measure.distance" /> (snaps to endpoints, edges, centres).
          Keep the result as an annotation if it should appear on the drawing.
        </li>
        <li>
          Export with <Cmd id="export.dialog" />.
        </li>
      </ol>
    ),
  },
  {
    id: 'w3',
    title: 'W3 — Area allocation and laydown',
    keywords: 'area allocation laydown schedule fill hatch label xlsx table',
    body: (
      <ol className="list-decimal space-y-1.5 pl-5">
        <li>Import and calibrate the plot plan.</li>
        <li>
          Create a layer per use (e.g. “Laydown”, “Construction”, “Keep clear”) in the Layers tab, and give
          each its colour and fill.
        </li>
        <li>
          Draw the areas with <Cmd id="draw.polygon" />, <Cmd id="draw.rect" /> or{' '}
          <Cmd id="draw.rectRotated" />. Type exact dimensions while drawing (e.g. <code>40,25</code> for a 40
          × 25 m rectangle), or trace them from the drawing. Area and perimeter are calculated as you draw.
        </li>
        <li>
          Label areas with a template such as <code>{'{name} – {area} m²'}</code>. Add attributes (owner,
          contractor, dates) in the Properties panel. Attributes become columns in the area schedule.
        </li>
        <li>
          Review everything in <Cmd id="data.objectsTable" />. It can be searched, sorted and filtered, and
          clicking a row selects and zooms to it.
        </li>
        <li>
          In <Cmd id="export.dialog" />, export the drawing (PDF) and the area schedule as XLSX. The schedule
          includes areas, perimeters, centroids, attributes and totals, with the calibration details on an
          information sheet.
        </li>
      </ol>
    ),
  },
  {
    id: 'w4',
    title: 'W4 — Sub-drawing on the plot plan',
    keywords: 'sub-drawing area layout align two points overlay shared coordinates',
    body: (
      <ol className="list-decimal space-y-1.5 pl-5">
        <li>Import the plot plan and calibrate it.</li>
        <li>
          Import the area layout (a second drawing). In the Layers tab, set its opacity or ghost mode, and its
          draw order.
        </li>
        <li>
          Run <Cmd id="calibration.align" />. If the area layout already uses plant coordinates, choose
          “Shared coordinates”. Otherwise pick two features on the area layout and then the same two features
          on the plot plan. The layout is moved, rotated and scaled to fit; you can keep its own scale.
        </li>
        <li>
          Analyse across both drawings. Snapping, tracing, offsets, measurements and contours work on every
          visible drawing in the same world coordinates.
        </li>
        <li>
          Export as usual. Both drawings are drawn as vectors, and the calibration state of each is stated.
        </li>
      </ol>
    ),
  },
];
