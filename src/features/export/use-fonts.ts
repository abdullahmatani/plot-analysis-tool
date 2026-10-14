import { useEffect, useState } from 'react';

import type { FontSet } from '@/export/fonts';

import { fontBase, loadFontSet } from './fonts-loader';

let loaded: FontSet | undefined;

/** The bundled export fonts on the main thread (loaded on first use; undefined until ready). */
export function useExportFonts(): FontSet | undefined {
  const [fonts, setFonts] = useState<FontSet | undefined>(loaded);
  useEffect(() => {
    if (loaded) return;
    let alive = true;
    loadFontSet(fontBase())
      .then((f) => {
        loaded = f;
        if (alive) setFonts(f);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return fonts;
}
