const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const CATALOG = path.join(__dirname, 'data', 'catalog.json');
const MAX_AGE_DAYS = 7;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

let syncing = false;

function catalogAgeDays() {
  try { return (Date.now() - fs.statSync(CATALOG).mtimeMs) / 864e5; } catch { return Infinity; }
}

// Re-crawl oshoworld in the background when the catalog is missing or stale.
function syncIfStale() {
  if (syncing || catalogAgeDays() < MAX_AGE_DAYS) return;
  syncing = true;
  console.log('catalog is stale, syncing from oshoworld.com...');
  const p = spawn(process.execPath, [path.join(__dirname, 'scripts', 'sync.js')], { stdio: 'inherit' });
  p.on('exit', () => { syncing = false; });
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/catalog') {
    if (!fs.existsSync(CATALOG)) {
      res.writeHead(503, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ syncing: true }));
    }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
    return fs.createReadStream(CATALOG).pipe(res);
  }
  // Audio goes through us so it is same-origin; that lets the page analyse it for the equalizer.
  if (url.pathname === '/stream') {
    const f = url.searchParams.get('f') || '';
    if (!f.startsWith('/wp-content/uploads/') || f.includes('..')) {
      res.writeHead(400);
      return res.end('bad path');
    }
    const headers = { 'user-agent': 'Mozilla/5.0 (adhyat player)' };
    if (req.headers.range) headers.range = req.headers.range;
    const up = https.get('https://oshoworld.com' + f, { headers }, r => {
      const out = { 'content-type': 'audio/mpeg', 'accept-ranges': 'bytes' };
      for (const h of ['content-length', 'content-range', 'accept-ranges']) if (r.headers[h]) out[h] = r.headers[h];
      res.writeHead(r.statusCode, out);
      r.pipe(res);
    });
    up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.on('close', () => up.destroy());
    return;
  }
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname);
  const file = path.join(PUBLIC, path.normalize(rel));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    return res.end('not found');
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => {
  console.log(`adhyat on http://localhost:${PORT}`);
  syncIfStale();
});
