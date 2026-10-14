#!/usr/bin/env python3
"""Plot Analysis Tool - offline launcher (Python 3, standard library only).

Serves the app from ./app on http://localhost:8765/ (this computer only) and opens it in the
default browser. Browsers block workers, WebAssembly and service workers on file:// pages, so a
tiny local web server is needed. Nothing is sent over the network. Press Ctrl+C to stop.
"""
import argparse
import http.server
import os
import sys
import webbrowser

CSP = "__CSP__"
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "app")


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm",
        ".webmanifest": "application/manifest+json", ".woff2": "font/woff2", ".ttf": "font/ttf",
        ".bcmap": "application/octet-stream", ".pfb": "application/octet-stream", ".icc": "application/vnd.iccprofile",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Content-Security-Policy", CSP)
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        super().end_headers()

    def send_head(self):
        path = self.translate_path(self.path)
        if not os.path.exists(path) and not os.path.splitext(self.path.split("?")[0])[1]:
            self.path = "/index.html"
        return super().send_head()

    def log_message(self, fmt, *args):
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true")
    a = ap.parse_args()
    url = f"http://localhost:{a.port}/"
    try:
        server = http.server.ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    except OSError:
        print(f"Port {a.port} is already in use - the app may already be running. Open {url}")
        if not a.no_browser:
            webbrowser.open(url)
        sys.exit(1)
    print(f"Plot Analysis Tool is running at {url} (Ctrl+C to stop)", flush=True)
    if not a.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
