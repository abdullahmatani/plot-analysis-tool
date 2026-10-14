/**
 * Tables: import (CSV / TSV / XLSX / clipboard), column-mapping suggestions, row filters, style
 * rules, label templates, validation, re-import diff and contour computation for bulk contour
 * datasets (FDR §8.9, rows 62–74; XLSX/CSV export for row 80). Everything here is pure and safe
 * to run in a Web Worker (no DOM, no eval, no network).
 */
export * from './access';
export * from './clipboard';
export * from './contours';
export * from './csv';
export * from './decode';
export * from './diff';
export * from './filter';
export * from './style-rules';
export * from './suggest';
export * from './table';
export * from './template';
export * from './validate';
export * from './values';
export * from './xlsx';
export * from './xml';
