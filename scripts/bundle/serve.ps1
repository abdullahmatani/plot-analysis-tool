# Plot Analysis Tool - offline launcher for Windows (no installation, no administrator rights).
# Serves the app from the "app" folder on http://localhost:8765/ (this computer only) and opens it.
# Browsers do not allow workers, WebAssembly or service workers from file:// pages, so a tiny local
# web server is needed. Nothing is sent over the network; close this window to stop the app.
param([int]$Port = 8765, [switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'app')) + [System.IO.Path]::DirectorySeparatorChar
$url = "http://localhost:$Port/"
$csp = "__CSP__"
$mime = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.mjs' = 'text/javascript; charset=utf-8'
  '.css' = 'text/css; charset=utf-8'; '.json' = 'application/json'; '.webmanifest' = 'application/manifest+json'
  '.wasm' = 'application/wasm'; '.svg' = 'image/svg+xml'; '.png' = 'image/png'; '.ico' = 'image/x-icon'
  '.woff2' = 'font/woff2'; '.woff' = 'font/woff'; '.ttf' = 'font/ttf'; '.txt' = 'text/plain; charset=utf-8'
  '.pfb' = 'application/octet-stream'; '.bcmap' = 'application/octet-stream'; '.icc' = 'application/vnd.iccprofile'
}
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
try { $listener.Start() } catch {
  Write-Host "Port $Port is already in use - the app may already be running. Opening $url"
  if (-not $NoBrowser) { Start-Process $url }
  exit 1
}
Write-Host "Plot Analysis Tool is running at $url"
Write-Host 'Keep this window open while you work. Close it to stop the app. Your work is saved in the browser.'
if (-not $NoBrowser) { Start-Process $url }
while ($true) {
  $client = $listener.AcceptTcpClient()
  try {
    $stream = $client.GetStream()
    $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::ASCII, $false, 8192, $true)
    $requestLine = $reader.ReadLine()
    if (-not $requestLine) { continue }
    while ($true) { $h = $reader.ReadLine(); if ($null -eq $h -or $h -eq '') { break } }
    $parts = $requestLine.Split(' ')
    $method = $parts[0]
    $path = [System.Uri]::UnescapeDataString($parts[1].Split('?')[0])
    if ($path -eq '/') { $path = '/index.html' }
    $full = [System.IO.Path]::GetFullPath((Join-Path $root $path.TrimStart('/')))
    $status = '200 OK'
    if (-not $full.StartsWith($root) -or -not [System.IO.File]::Exists($full)) {
      if ([System.IO.Path]::GetExtension($path) -eq '') { $full = Join-Path $root 'index.html' }
      else { $status = '404 Not Found'; $full = $null }
    }
    if ($full) { $body = [System.IO.File]::ReadAllBytes($full); $type = $mime[[System.IO.Path]::GetExtension($full).ToLower()] }
    else { $body = [System.Text.Encoding]::UTF8.GetBytes('Not found'); $type = 'text/plain' }
    if (-not $type) { $type = 'application/octet-stream' }
    $header = "HTTP/1.1 $status`r`nContent-Type: $type`r`nContent-Length: $($body.Length)`r`nCache-Control: no-cache`r`nContent-Security-Policy: $csp`r`nX-Content-Type-Options: nosniff`r`nReferrer-Policy: no-referrer`r`nConnection: close`r`n`r`n"
    $hb = [System.Text.Encoding]::ASCII.GetBytes($header)
    $stream.Write($hb, 0, $hb.Length)
    if ($method -ne 'HEAD') { $stream.Write($body, 0, $body.Length) }
    $stream.Flush()
  } catch { } finally { $client.Close() }
}
