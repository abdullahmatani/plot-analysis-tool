#!/usr/bin/env node
/** One-off: renders public/favicon.svg to the PNG icons used by the PWA manifest. */
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';

const svg = readFileSync('public/favicon.svg', 'utf8');
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [size, file, pad, bg] of [
  [192, 'public/icons/icon-192.png', 0, 'transparent'],
  [512, 'public/icons/icon-512.png', 0, 'transparent'],
  [512, 'public/icons/icon-512-maskable.png', 0.12, '#0f172a'],
]) {
  await page.setViewportSize({ width: size, height: size });
  const inner = Math.round(size * (1 - pad * 2));
  await page.setContent(
    `<html><body style="margin:0;background:${bg};display:grid;place-items:center;width:${size}px;height:${size}px">${svg.replace('<svg ', `<svg width="${inner}" height="${inner}" `)}</body></html>`,
  );
  writeFileSync(file, await page.screenshot({ omitBackground: bg === 'transparent' }));
}
await browser.close();
console.log('icons written');
