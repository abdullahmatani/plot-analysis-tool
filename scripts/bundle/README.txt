Plot Analysis Tool __VERSION__ - offline bundle
================================================

One-line start
  Windows:        double-click "Start Plot Analysis Tool.cmd"
  macOS / Linux:  sh start.sh        (needs Python 3 or Node.js)

The app then opens at http://localhost:8765/ in your default browser (use a current Chrome or
Edge for best results). Keep the launcher window open while you work; close it to stop.

Why a launcher? Browsers do not allow the parts of the app that read DWG and PDF files (Web
Workers and WebAssembly), or offline caching, on pages opened directly from disk (file://).
The launcher is a tiny web server that only listens on this computer (127.0.0.1); it never
contacts the internet, and the app itself never sends drawings or projects anywhere.

Where is my work saved? Automatically, in this browser's private storage for
http://localhost:8765/ (always use the same browser and port). Use File > Save to file to
keep a portable .patproj copy, e.g. for backups or other computers.

After the first launch the app is also installed for offline use in the browser: you can open
http://localhost:8765/ again while the launcher is running, or install it as an app from the
browser menu.

Contents
  app/                           the application (static files)
  Start Plot Analysis Tool.cmd   Windows launcher (PowerShell, no installation or admin rights)
  serve.ps1                      the Windows local server
  serve.py / serve.mjs / start.sh  launchers for Python 3 / Node.js
  THIRD-PARTY-NOTICES.txt        third-party components and their licences
Third-party licences are also listed in the app under Help > About, privacy and licences.
