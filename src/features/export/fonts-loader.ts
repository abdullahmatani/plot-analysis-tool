import { createFontSet, type FontBytes, type FontSet } from '@/export/fonts';

/**
 * Loads the bundled export fonts (Noto Sans and Noto Sans Arabic, OFL) from the app's own origin
 * (`fonts/`, copied there at build time) — never from the network (C3). Works on the main thread
 * and in workers; the parsed set is cached per base URL.
 */

export const FONT_FILES = {
  sans: 'NotoSans-Regular.ttf',
  sansBold: 'NotoSans-Bold.ttf',
  arabic: 'NotoSansArabic-Regular.ttf',
  arabicBold: 'NotoSansArabic-Bold.ttf',
} as const;

const cache = new Map<string, Promise<FontSet>>();

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Font ${url} could not be loaded (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

export async function loadFontBytes(base: string): Promise<FontBytes> {
  const [sans, sansBold, arabic, arabicBold] = await Promise.all(
    [FONT_FILES.sans, FONT_FILES.sansBold, FONT_FILES.arabic, FONT_FILES.arabicBold].map((f) =>
      fetchBytes(new URL(f, base).href),
    ),
  );
  return { sans, sansBold, arabic, arabicBold };
}

/** Font set for `base` (a URL ending in `fonts/`). */
export function loadFontSet(base: string): Promise<FontSet> {
  let p = cache.get(base);
  if (!p) {
    p = loadFontBytes(base).then(createFontSet);
    p.catch(() => cache.delete(base));
    cache.set(base, p);
  }
  return p;
}

/** Base URL of the bundled fonts for the current document (main thread). */
export function fontBase(): string {
  return new URL('./fonts/', document.baseURI).href;
}
