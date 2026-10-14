/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string };

/**
 * Content Security Policy for production builds (C4, row 7). Only same-origin resources are
 * allowed; `wasm-unsafe-eval` permits WebAssembly compilation (DWG parser, pdf.js decoders)
 * without allowing JavaScript eval. `blob:` is needed for worker bootstrapping and object URLs
 * created from local files.
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "connect-src 'self' blob: data:",
  "img-src 'self' blob: data:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "manifest-src 'self'",
].join('; ');

/**
 * Copies pdf.js runtime assets (CMaps, standard fonts, decoders, ICC profiles) and the open-licence
 * export/CAD fallback fonts into public/ so they are bundled and precached (C3: no runtime downloads).
 */
function bundledAssets(): Plugin {
  const copy = () => {
    const fontsDir = path.join(root, 'public/fonts');
    mkdirSync(fontsDir, { recursive: true });
    const fonts: [string, string][] = [
      ['@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf', 'NotoSans-Regular.ttf'],
      ['@expo-google-fonts/noto-sans/700Bold/NotoSans_700Bold.ttf', 'NotoSans-Bold.ttf'],
      [
        '@expo-google-fonts/noto-sans-arabic/400Regular/NotoSansArabic_400Regular.ttf',
        'NotoSansArabic-Regular.ttf',
      ],
      ['@expo-google-fonts/noto-sans-arabic/700Bold/NotoSansArabic_700Bold.ttf', 'NotoSansArabic-Bold.ttf'],
      ['@expo-google-fonts/noto-sans/LICENSE_FONT', 'OFL.txt'],
    ];
    for (const [from, to] of fonts) {
      const dest = path.join(fontsDir, to);
      if (!existsSync(dest)) cpSync(path.join(root, 'node_modules', from), dest);
    }
    const src = path.join(root, 'node_modules/pdfjs-dist');
    const dest = path.join(root, 'public/pdfjs');
    for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
      const to = path.join(dest, dir);
      if (existsSync(to) && readdirSync(to).length > 0) continue;
      mkdirSync(to, { recursive: true });
      cpSync(path.join(src, dir), to, {
        recursive: true,
        // PDF JavaScript is never executed, so the QuickJS sandbox is not shipped.
        filter: (f) => !path.basename(f).startsWith('quickjs'),
      });
    }
  };
  return { name: 'pat-pdfjs-assets', buildStart: copy, configureServer: copy };
}

/** Injects the CSP meta tag into the built index.html (not in dev, where HMR needs inline scripts and websockets). */
function cspMeta(): Plugin {
  return {
    name: 'pat-csp-meta',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<meta charset="UTF-8" />',
        `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
      );
    },
  };
}

export default defineConfig({
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [
    bundledAssets(),
    react(),
    tailwindcss(),
    cspMeta(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['favicon.svg', 'icons/*.png', 'pdfjs/**/*', 'fonts/**/*'],
      manifest: {
        name: 'Plot Analysis Tool',
        short_name: 'Plot Analysis',
        description: 'Offline, private spatial analysis on plot plans (DXF, DWG, PDF).',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        start_url: './',
        scope: './',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        file_handlers: [
          {
            action: './',
            accept: {
              'application/dxf': ['.dxf'],
              'application/acad': ['.dwg'],
              'application/pdf': ['.pdf'],
              'application/x-plot-analysis-project': ['.patproj'],
            },
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,ico,wasm,woff,woff2,ttf,pfb,bcmap,icc,json,txt}'],
        maximumFileSizeToCacheInBytes: 32 * 1024 * 1024,
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
        // No runtime caching rules: nothing is ever fetched from another origin (C3).
      },
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: { '@': path.join(root, 'src') },
  },
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 4096,
    assetsInlineLimit: 0,
  },
  server: {
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin' },
  },
  preview: {
    headers: { 'Content-Security-Policy': CSP },
  },
  test: {
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['./src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/geometry/**/*.ts'],
      exclude: ['**/*.test.ts'],
      reporter: ['text-summary', 'json-summary'],
    },
  },
});
