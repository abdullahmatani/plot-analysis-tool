/**
 * Test-only helper: loads the OFL Noto fonts shipped as devDependencies so the export tests can
 * shape real text in Node. Not imported by application code (the app passes the same TTFs, served
 * from `fonts/`, as ArrayBuffers).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createFontSet } from './fonts';
import type { FontBytes, FontSet } from './fonts';

const root = fileURLToPath(new URL('../../node_modules/@expo-google-fonts/', import.meta.url));

export function readTestFont(rel: string): Uint8Array {
  return new Uint8Array(readFileSync(root + rel));
}

export function testFontBytes(): FontBytes {
  return {
    sans: readTestFont('noto-sans/400Regular/NotoSans_400Regular.ttf'),
    sansBold: readTestFont('noto-sans/700Bold/NotoSans_700Bold.ttf'),
    arabic: readTestFont('noto-sans-arabic/400Regular/NotoSansArabic_400Regular.ttf'),
    arabicBold: readTestFont('noto-sans-arabic/700Bold/NotoSansArabic_700Bold.ttf'),
  };
}

let cached: FontSet | undefined;

export function testFontSet(): FontSet {
  cached ??= createFontSet(testFontBytes());
  return cached;
}
