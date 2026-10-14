import { describe, expect, it } from 'vitest';

import { formatTemplateValue, parseTemplate, renderTemplate, templateFields } from './template';

describe('renderTemplate', () => {
  const ctx = {
    Label: 'Jet fire',
    radius: 12.3456,
    'Radiation 4 kW/m2 (m)': 40,
    count: 3,
    text: '7.25',
    none: null,
  };

  it('substitutes fields case-insensitively', () => {
    expect(renderTemplate('{label} – {RADIUS:0.0} m', ctx)).toBe('Jet fire – 12.3 m');
    expect(renderTemplate('{Radiation 4 kW/m2 (m)} m', ctx)).toBe('40 m');
  });

  it('formats fixed decimals and integers', () => {
    expect(renderTemplate('{radius:0}', ctx)).toBe('12');
    expect(renderTemplate('{radius:0.00}', ctx)).toBe('12.35');
    expect(renderTemplate('{count:0.0}', ctx)).toBe('3.0');
    expect(renderTemplate('{text:0.0}', ctx)).toBe('7.3');
  });

  it('applies default precision without trailing zeros', () => {
    expect(renderTemplate('{radius}', ctx)).toBe('12.3456');
    expect(renderTemplate('{radius}', ctx, { precision: 1 })).toBe('12.3');
    expect(renderTemplate('{x}', { x: 0.1 + 0.2 })).toBe('0.3');
  });

  it('renders missing and null fields as empty, keeps escaped braces and unclosed text', () => {
    expect(renderTemplate('[{missing}][{none}]', ctx)).toBe('[][]');
    expect(renderTemplate('{{label}} = {label}', ctx)).toBe('{label} = Jet fire');
    expect(renderTemplate('open {label', ctx)).toBe('open {label');
  });

  it('keeps colons that are not formats in field names', () => {
    expect(renderTemplate('{Time: start}', { 'time: start': '08:00' })).toBe('08:00');
  });

  it('lists template fields', () => {
    expect(templateFields('{label} – {radius:0.0} m ({Label})')).toEqual(['label', 'radius']);
    expect(parseTemplate('a{b}c')).toEqual(['a', { field: 'b', key: 'b' }, 'c']);
  });

  it('formats values', () => {
    expect(formatTemplateValue(true)).toBe('TRUE');
    expect(formatTemplateValue(NaN)).toBe('');
    expect(formatTemplateValue(-0.0001, undefined, 2)).toBe('0');
  });
});
