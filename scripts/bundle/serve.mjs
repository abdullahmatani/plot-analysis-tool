#!/usr/bin/env node
// Plot Analysis Tool - offline launcher (Node.js, no dependencies).
// Serves ./app on http://localhost:8765/ (this computer only). Ctrl+C to stop.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { exec } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CSP = '__CSP__';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'app');
const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]) || 8765;
const noBrowser = args.includes('--no-browser');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.icc': 'application/vnd.iccprofile',
};

const server = createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  let file = path.join(root, p);
  if (!file.startsWith(root + path.sep)) file = '';
  try {
    if (!file || !(await stat(file)).isFile()) throw new Error();
  } catch {
    if (path.extname(p)) {
      res.writeHead(404).end('Not found');
      return;
    }
    file = path.join(root, 'index.html');
  }
  const body = await readFile(file);
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Security-Policy': CSP,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
});
server.on('error', () => {
  console.log(
    `Port ${port} is already in use - the app may already be running. Open http://localhost:${port}/`,
  );
  process.exit(1);
});
server.listen(port, '127.0.0.1', () => {
  const url = `http://localhost:${port}/`;
  console.log(`Plot Analysis Tool is running at ${url} (Ctrl+C to stop)`);
  if (!noBrowser) {
    const cmd =
      process.platform === 'win32'
        ? `start "" "${url}"`
        : process.platform === 'darwin'
          ? `open "${url}"`
          : `xdg-open "${url}"`;
    exec(cmd, () => {});
  }
});
