import { describe, expect, it } from 'vitest';

import type { StyleRule } from '@/core/types';

import {
  applyTemplate,
  deleteTemplate,
  listTemplates,
  makeTemplate,
  matchTemplates,
  saveTemplate,
} from './templates';

const columns = ['Tag', 'Scenario', 'Category', 'X', 'Y', 'R4 (m)', 'R12 (m)'];
const rule: StyleRule = {
  id: 'r1',
  kind: 'categorical',
  column: 'Category',
  categories: [{ value: 'Jet fire', color: '#ff0000' }],
};

function template(name = 'Consequences') {
  return makeTemplate(name, columns, {
    mapping: {
      position: { mode: 'anchor', anchor: 'Tag' },
      sizeColumns: ['R4 (m)', 'R12 (m)'],
      sizeMode: 'radius',
      sizeUnit: 'm',
      label: 'Scenario',
      group: 'Category',
    },
    sizeStyles: [
      { column: 'R4 (m)', visible: true, color: '#abcdef', dash: 'dash', fillOpacity: 0.2, strokeWidth: 0.5 },
    ],
    styleRules: [rule],
    labelTemplate: '{label} – {radius} m',
    labelPlacement: 'leader',
  });
}

describe('mapping templates (row 73)', () => {
  it('matches tables with the template headers (case/space-insensitive), exact first', () => {
    const t = template();
    const other = makeTemplate('Other', ['A', 'B'], {
      ...t,
      mapping: { ...t.mapping, sizeColumns: ['A'], position: { mode: 'anchor', anchor: 'B' } },
    });
    const m = matchTemplates(
      [other, t],
      columns.map((c) => c.toUpperCase()),
    );
    expect(m.map((x) => x.template.name)).toEqual(['Consequences']);
    expect(m[0].exact).toBe(true);
    // A table with an extra column still matches (not exact); one missing a mapped column does not.
    expect(matchTemplates([t], [...columns, 'Notes'])[0].exact).toBe(false);
    expect(
      matchTemplates(
        [t],
        columns.filter((c) => c !== 'R12 (m)'),
      ),
    ).toEqual([]);
  });

  it('applies mapping, styles, rules and label template with the table spelling', () => {
    const a = applyTemplate(
      template(),
      columns.map((c) => c.toLowerCase()),
    );
    expect(a.mapping.position.anchor).toBe('tag');
    expect(a.mapping.sizeColumns).toEqual(['r4 (m)', 'r12 (m)']);
    expect(a.sizeStyles[0]).toMatchObject({ column: 'r4 (m)', color: '#abcdef', dash: 'dash' });
    expect(a.styleRules[0]).toMatchObject({ kind: 'categorical', column: 'category' });
    expect(a.styleRules[0].id).not.toBe('r1');
    expect(a.labelTemplate).toBe('{label} – {radius} m');
    expect(a.labelPlacement).toBe('leader');
  });

  it('persists templates across projects in the settings store', async () => {
    await saveTemplate(template('T1'));
    await saveTemplate(template('T2'));
    await saveTemplate(template('T1')); // same name replaces
    let list = await listTemplates();
    expect(list.map((t) => t.name).sort()).toEqual(['T1', 'T2']);
    await deleteTemplate(list[0].id);
    list = await listTemplates();
    expect(list).toHaveLength(1);
  });
});
