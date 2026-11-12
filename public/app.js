const SOURCE = 'https://oshoworld.com';
const STORE = 'adhyat';
const SPEEDS = [1, 1.25, 1.5, 2, 0.75];

const $ = id => document.getElementById(id);
const audio = $('audio');

let series = [];
let cur = { series: null, i: 0 };
let lang = 'hindi';
let openFolder = null;
let rate = 0;

const saved = (() => { try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return {}; } })();
const save = patch => {
  Object.assign(saved, patch);
  try { localStorage.setItem(STORE, JSON.stringify(saved)); } catch {}
};

const fmt = s => {
  if (!isFinite(s)) s = 0;
  s = Math.floor(s);
  const h = Math.floor(s / 3600);
  const m = String(Math.floor(s / 60) % 60).padStart(h ? 2 : 1, '0');
  return `${h}:${m}:${String(s % 60).padStart(2, '0')}`;
};
const cleanTitle = t => t.replace(/\s*#\s*\d+\s*-\s*\d+\s*$/, '').trim();

// ---------- offline downloads ----------
// Saved discourses live in Cache Storage under their /stream URL; playback then uses a blob URL so it works with no network.

const AUDIO_CACHE = 'adhyat-audio';
const streamUrl = file => `/stream?f=${encodeURIComponent(file)}`;
const offline = new Set();
const downloading = new Map(); // file -> { pct, abort }
let loadToken = 0;
let blobUrl = null;

async function sourceFor(file) {
  if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
  if (offline.has(file)) {
    try {
      const hit = await (await caches.open(AUDIO_CACHE)).match(streamUrl(file));
      if (hit) return (blobUrl = URL.createObjectURL(await hit.blob()));
    } catch {}
  }
  return streamUrl(file);
}

async function download(file) {
  if (downloading.has(file) || !window.caches) return;
  const job = { pct: 0, abort: new AbortController() };
  downloading.set(file, job);
  renderSave();
  try {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
    const res = await fetch(streamUrl(file), { signal: job.abort.signal });
    if (!res.ok) throw new Error(res.status);
    const total = +res.headers.get('content-length') || 0;
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      job.pct = total ? Math.floor((got / total) * 100) : 0;
      renderSave();
    }
    await (await caches.open(AUDIO_CACHE)).put(streamUrl(file), new Response(new Blob(chunks), { headers: { 'content-type': 'audio/mpeg' } }));
    offline.add(file);
  } catch (e) {
    if (e.name !== 'AbortError') $('album').textContent = 'Download failed (is the disk full?)';
  }
  downloading.delete(file);
  renderSave();
}

async function removeDownload(file) {
  try { await (await caches.open(AUDIO_CACHE)).delete(streamUrl(file)); } catch {}
  offline.delete(file);
  renderSave();
}

const rowBtns = new Map(); // file -> the save button on its library row

function saveLabel(file) {
  const job = downloading.get(file);
  return job ? `${job.pct}%` : offline.has(file) ? '\u2713' : '\u2193';
}

function toggleSave(file) {
  const job = downloading.get(file);
  if (job) job.abort.abort();
  else if (offline.has(file)) removeDownload(file);
  else download(file);
}

function renderSave() {
  for (const [file, btn] of rowBtns) {
    btn.textContent = saveLabel(file);
    btn.classList.toggle('on', offline.has(file));
  }
  const b = $('save');
  const t = cur.series && cur.series.tracks[cur.i];
  b.disabled = !t || !window.caches;
  if (!t) return (b.textContent = saveLabel());
  const job = downloading.get(t.file);
  b.textContent = saveLabel(t.file);
  b.classList.toggle('on', offline.has(t.file));
  b.title = job ? 'Cancel download' : offline.has(t.file) ? 'Remove offline copy' : 'Download to play offline';
}

$('save').onclick = () => toggleSave(cur.series.tracks[cur.i].file);

// ---------- playback ----------

function load(s, i, { play = false, at = 0 } = {}) {
  cur = { series: s, i };
  const t = s.tracks[i];
  const token = ++loadToken;
  sourceFor(t.file).then(src => {
    if (token !== loadToken) return;
    audio.src = src;
    if (at) audio.addEventListener('loadedmetadata', () => { audio.currentTime = at; }, { once: true });
    if (play) audio.play().catch(() => {});
  });
  renderSave();

  $('title').textContent = t.title;
  $('album').textContent = cleanTitle(s.title);
  $('lang').textContent = s.lang.toUpperCase();
  $('trackno').textContent = `TRACK ${i + 1}/${s.tracks.length}`;
  $('dur').textContent = t.dur || '0:00:00';
  const img = $('cover');
  if (s.image) img.src = `${SOURCE}/${s.image}`; else img.removeAttribute('src');
  document.title = `${t.title} · Adhyat`;
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title,
      artist: 'Osho',
      album: cleanTitle(s.title),
      artwork: s.image ? [{ src: `${SOURCE}/${s.image}` }] : [],
    });
  }
  save({ series: s.slug, i, t: at });
  if (openFolder === s) renderTracks();
}

function step(d) {
  const n = cur.i + d;
  if (!cur.series || n < 0 || n >= cur.series.tracks.length) return;
  load(cur.series, n, { play: true });
}

function toggle() {
  if (!cur.series) return showLibrary(true);
  audio.paused ? audio.play().catch(() => {}) : audio.pause();
}

audio.addEventListener('play', () => { $('play').innerHTML = '&#10074;&#10074;'; });
audio.addEventListener('pause', () => { $('play').innerHTML = '&#9654;'; });
audio.addEventListener('ended', () => step(1));
audio.addEventListener('loadedmetadata', () => { $('dur').textContent = fmt(audio.duration); });
let lastSave = 0;
audio.addEventListener('timeupdate', () => {
  const d = audio.duration || 0;
  $('cur').textContent = fmt(audio.currentTime);
  $('fill').style.width = d ? `${(audio.currentTime / d) * 100}%` : '0';
  if (Date.now() - lastSave > 3000) { lastSave = Date.now(); save({ t: audio.currentTime }); }
});
audio.addEventListener('error', () => { $('album').textContent = 'Could not load this audio'; });

$('bar').addEventListener('click', e => {
  const r = e.currentTarget.getBoundingClientRect();
  if (audio.duration) audio.currentTime = ((e.clientX - r.left) / r.width) * audio.duration;
});
$('play').onclick = toggle;
$('prev').onclick = () => (audio.currentTime > 5 ? (audio.currentTime = 0) : step(-1));
$('next').onclick = () => step(1);
$('back30').onclick = () => { audio.currentTime = Math.max(0, audio.currentTime - 30); };
$('fwd30').onclick = () => { audio.currentTime += 30; };
$('vol').oninput = e => { audio.volume = +e.target.value; save({ vol: audio.volume }); };
$('speed').onclick = () => setRate((rate + 1) % SPEEDS.length);

function setRate(i) {
  rate = i;
  audio.playbackRate = SPEEDS[i];
  $('speed').textContent = `${SPEEDS[i]}x`;
  save({ rate: i });
}

if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', toggle);
  navigator.mediaSession.setActionHandler('pause', toggle);
  navigator.mediaSession.setActionHandler('previoustrack', () => step(-1));
  navigator.mediaSession.setActionHandler('nexttrack', () => step(1));
}

document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' && e.target.type === 'search') return;
  if (e.code === 'Space') { e.preventDefault(); toggle(); }
  else if (e.code === 'ArrowRight') audio.currentTime += 30;
  else if (e.code === 'ArrowLeft') audio.currentTime = Math.max(0, audio.currentTime - 30);
  else if (e.key === 'n') step(1);
  else if (e.key === 'p') step(-1);
  else if (e.key === 'l') showLibrary($('library').hidden);
});

// ---------- visualizer ----------
// Boxes follow the live spectrum and lines the live waveform of the playing audio (via an AnalyserNode, which works because
// the audio is served same-origin through /stream). Without Web Audio they fall back to a sine wobble.

const eq = $('eq');
const ctx = eq.getContext('2d');
const LINES = [
  { color: '#2f7d32', width: 2.5, gain: 1.0, phase: 0 },
  { color: '#e8a317', width: 1.5, gain: 0.7, phase: 0.6 },
  { color: '#d9362b', width: 1, gain: 0.45, phase: 1.2 },
];
let analyser = null;
let wave = null;
let hp = null;
let freq = null;
let amp = 0;
let norm = 1;

function setupAnalyser() {
  if (analyser) return;
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const src = ac.createMediaElementSource(audio);
    analyser = ac.createAnalyser();
    analyser.fftSize = 1024;
    src.connect(analyser);
    analyser.connect(ac.destination);
    wave = new Uint8Array(analyser.fftSize);
    hp = new Float32Array(analyser.fftSize);
    freq = new Uint8Array(analyser.frequencyBinCount);
    analyser.smoothingTimeConstant = 0.6;
    audio.addEventListener('play', () => ac.resume());
  } catch { analyser = null; }
}
audio.addEventListener('play', setupAnalyser);

const VIZ = ['bars', 'lines', 'ring', 'ripple', 'dots'];
const VIZ_LABEL = { bars: 'BOX', lines: 'LINE', ring: 'RING', ripple: 'RIPPLE', dots: 'DOTS' };
let viz = VIZ.includes(saved.viz) ? saved.viz : 'bars';

function setViz(v) {
  viz = v;
  $('viz').textContent = VIZ_LABEL[v];
  save({ viz });
}
$('viz').onclick = () => setViz(VIZ[(VIZ.indexOf(viz) + 1) % VIZ.length]);
setViz(viz);

const COLS = 26, SEG = 6, GAP = 2, TRIM_ROWS = 2;
const lvl = new Array(COLS).fill(0);
const target = new Array(COLS).fill(0);

// Coloured boxes, one column per slice of the spectrum, like a VU meter.
function drawBars(w, h, playing) {
  const rows = Math.max(1, Math.floor((h + GAP) / (SEG + GAP)) - TRIM_ROWS);
  const colW = (w - GAP * (COLS - 1)) / COLS;
  for (let c = 0; c < COLS; c++) {
    if (analyser) {
      // Speech sits low, so spread columns over the first ~60% of the spectrum, log-spaced.
      const lo = Math.floor(Math.pow(c / COLS, 1.6) * freq.length * 0.6);
      const hi = Math.max(lo + 1, Math.floor(Math.pow((c + 1) / COLS, 1.6) * freq.length * 0.6));
      let sum = 0;
      for (let b = lo; b < hi; b++) sum += freq[b];
      target[c] = playing ? Math.min(1, (sum / (hi - lo) / 255) * (1.0 + 1.2 * c / COLS)) : 0;
    } else if (playing && Math.random() < 0.12) {
      const bass = 1 - Math.abs(c - COLS / 2) / COLS;
      target[c] = Math.random() * (0.35 + 0.65 * bass);
    }
    if (!playing) target[c] = 0;
    lvl[c] += (target[c] - lvl[c]) * (target[c] > lvl[c] ? 0.35 : 0.12);
    const lit = Math.round(lvl[c] * rows);
    for (let r = 0; r < rows; r++) {
      // Green at the bottom, amber in the middle, red at the top.
      const f = r / rows;
      const on = f < 0.55 ? '#2f7d32' : f < 0.8 ? '#e8a317' : '#d9362b';
      ctx.fillStyle = r < lit ? on : 'rgba(31,42,20,0.12)';
      ctx.fillRect(c * (colW + GAP), h - (r + 1) * SEG - r * GAP, colW, SEG);
    }
  }
}

// Three lines following the live waveform; flat when paused.
function drawLines(w, h, now, playing) {
  // Overall loudness drives how far the lines swing; it eases back to a flat line on pause.
  let peak = 0;
  if (analyser && playing) {
    analyser.getByteTimeDomainData(wave);
    // High-pass the waveform so slow rumble/DC offset doesn't bend the whole line to one side.
    let prev = 0, out = 0;
    for (let i = 0; i < wave.length; i++) {
      const x = (wave[i] - 128) / 128;
      out = x - prev + 0.9 * out;
      prev = x;
      hp[i] = out;
      peak = Math.max(peak, Math.abs(out));
    }
  } else if (playing) peak = 0.4;
  amp += (peak - amp) * 0.2;
  // Speech is quiet, so scale the swing to the recent loudness (auto-gain) to keep the lines lively.
  norm += (Math.min(20, 0.9 / Math.max(peak, 0.03)) - norm) * 0.05;

  const mid = h / 2;
  const N = 120;
  for (const ln of LINES) {
    ctx.beginPath();
    for (let i = 0; i <= N; i++) {
      const x = (i / N) * w;
      let v;
      if (analyser && playing) v = Math.max(-1, Math.min(1, hp[Math.min(hp.length - 1, Math.floor(i / N * hp.length))] * norm));
      else v = Math.sin(i * 0.25 + now / 150 + ln.phase) * 0.5 * Math.sin(i * 0.07 + now / 400);
      // Taper the ends so the line is anchored at both sides of the screen.
      const edge = Math.sin((i / N) * Math.PI);
      const y = mid - v * ln.gain * mid * 1.1 * edge * (playing ? 1 : 0);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.strokeStyle = ln.color;
    ctx.lineWidth = ln.width;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }
  // Faint centre line, like a scope graticule.
  ctx.fillStyle = 'rgba(31,42,20,0.15)';
  ctx.fillRect(0, mid - 0.5, w, 1);
}


// Shared, smoothed spectrum (NB bands) that the circular / dotted patterns read from.
const NB = 32;
const lv = new Array(NB).fill(0);
let bass = 0;
let bassAvg = 0;

function updateLevels(playing) {
  if (analyser && playing) analyser.getByteFrequencyData(freq);
  for (let c = 0; c < NB; c++) {
    let t = 0;
    if (analyser) {
      // Voice lives below ~6 kHz, so only the lower ~30% of the spectrum is spread over the bands.
      const lo = Math.floor(Math.pow(c / NB, 1.4) * freq.length * 0.3);
      const hi = Math.max(lo + 1, Math.floor(Math.pow((c + 1) / NB, 1.4) * freq.length * 0.3));
      let sum = 0;
      for (let b = lo; b < hi; b++) sum += freq[b];
      t = playing ? Math.min(1, (sum / (hi - lo) / 255) * (1.0 + 1.2 * c / NB)) : 0;
    } else if (playing) {
      t = Math.random() * (0.35 + 0.65 * (1 - Math.abs(c - NB / 2) / NB));
    }
    lv[c] += (t - lv[c]) * (t > lv[c] ? 0.35 : 0.12);
  }
  bass = (lv[0] + lv[1] + lv[2] + lv[3]) / 4;
}

const levelColor = f => (f < 0.55 ? '#2f7d32' : f < 0.8 ? '#e8a317' : '#d9362b');

// Spokes radiating from a pulsing circle, mirrored left/right, slowly turning.
function drawRing(w, h, now) {
  const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2;
  const r0 = R * 0.4 * (1 + 0.12 * bass);
  const maxLen = R * 0.55;
  const SPOKES = NB * 2;
  ctx.lineCap = 'round';
  ctx.lineWidth = 2.5;
  for (let i = 0; i < SPOKES; i++) {
    const l = lv[i < NB ? i : SPOKES - 1 - i];
    const a = (i / SPOKES) * Math.PI * 2 + now / 6000 - Math.PI / 2;
    const len = 2 + l * maxLen;
    ctx.strokeStyle = levelColor(l);
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
    ctx.lineTo(cx + Math.cos(a) * (r0 + len), cy + Math.sin(a) * (r0 + len));
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(31,42,20,0.35)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, r0 - 4, 0, Math.PI * 2);
  ctx.stroke();
}

// Rings sent out from the centre on every bass hit; they widen and fade.
const rings = [];
let lastBeat = 0;
function drawRipple(w, h, now, playing) {
  const cx = w / 2, cy = h / 2, maxR = Math.min(w / 2, h * 1.1);
  bassAvg += (bass - bassAvg) * 0.05;
  if (playing && bass > bassAvg * 1.25 + 0.04 && now - lastBeat > 220) {
    rings.push({ born: now, strength: Math.min(1, 0.4 + bass) });
    lastBeat = now;
  }
  const LIFE = 1400;
  for (let i = rings.length - 1; i >= 0; i--) {
    const age = (now - rings[i].born) / LIFE;
    if (age >= 1) { rings.splice(i, 1); continue; }
    const e = 1 - Math.pow(1 - age, 2);
    ctx.globalAlpha = (1 - age) * 0.9;
    ctx.strokeStyle = levelColor(1 - age * 0.9 - (1 - rings[i].strength) * 0.3);
    ctx.lineWidth = 1 + 4 * (1 - age) * rings[i].strength;
    ctx.beginPath();
    ctx.arc(cx, cy, 6 + e * maxR, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = levelColor(Math.min(1, bass * 1.5));
  ctx.beginPath();
  ctx.arc(cx, cy, 4 + bass * 14, 0, Math.PI * 2);
  ctx.fill();
}

// A dot matrix that swells outward from the middle row, like a mirrored equalizer.
function drawDots(w, h) {
  const ROWS = 9, mid = (ROWS - 1) / 2;
  const sx = w / NB, sy = h / ROWS;
  const rad = Math.min(sx, sy) * 0.4;
  for (let c = 0; c < NB; c++) {
    const lit = Math.round(lv[c] * (mid + 1));
    for (let r = 0; r < ROWS; r++) {
      const d = Math.abs(r - mid);
      const on = d < lit;
      ctx.fillStyle = on ? levelColor(d / mid) : 'rgba(31,42,20,0.2)';
      ctx.beginPath();
      ctx.arc(c * sx + sx / 2, r * sy + sy / 2, on ? rad : 1.3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawEq(now) {
  const dpr = devicePixelRatio || 1;
  const w = eq.clientWidth, h = eq.clientHeight;
  if (!w || !h) return requestAnimationFrame(drawEq);
  if (eq.width !== w * dpr) { eq.width = w * dpr; eq.height = h * dpr; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const playing = !audio.paused && !audio.ended;
  updateLevels(playing);
  if (viz === 'bars') drawBars(w, h, playing);
  else if (viz === 'lines') drawLines(w, h, now, playing);
  else if (viz === 'ring') drawRing(w, h, now);
  else if (viz === 'ripple') drawRipple(w, h, now, playing);
  else drawDots(w, h);
  requestAnimationFrame(drawEq);
}
requestAnimationFrame(drawEq);

// ---------- library ----------

function showLibrary(on) {
  $('library').hidden = !on;
  $('player').hidden = on;
  $('lib').textContent = on ? 'PLAYER' : 'LIBRARY';
  if (on) {
    if (cur.series && !openFolder) { lang = cur.series.lang; }
    renderList();
  }
}
$('lib').onclick = () => showLibrary($('library').hidden);

document.querySelectorAll('.tab').forEach(b => {
  b.onclick = () => { lang = b.dataset.lang; openFolder = null; $('search').value = ''; renderList(); };
});
$('back').onclick = () => { openFolder = null; renderList(); };
$('search').oninput = renderFolders;

function row(cls, title, right, onclick) {
  const li = document.createElement('li');
  li.className = cls;
  li.innerHTML = '<span class="t"></span><span class="c"></span>';
  li.firstChild.textContent = title;
  li.lastChild.textContent = right;
  li.onclick = onclick;
  return li;
}

function renderList() {
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('on', b.dataset.lang === lang));
  openFolder ? renderTracks() : renderFolders();
}

function renderFolders() {
  $('back').hidden = true;
  $('search').hidden = false;
  const q = $('search').value.trim().toLowerCase();
  const items = series.filter(s => s.lang === lang && (!q || s.title.toLowerCase().includes(q)));
  $('crumb').textContent = `${items.length} FOLDERS`;
  const ul = $('list');
  ul.replaceChildren(...(items.length
    ? items.map(s => row('folder', cleanTitle(s.title), s.tracks.length, () => { openFolder = s; renderList(); ul.scrollTop = 0; }))
    : [row('empty', 'Nothing found', '')]));
}

function renderTracks() {
  rowBtns.clear();
  $('back').hidden = false;
  $('search').hidden = true;
  $('crumb').textContent = cleanTitle(openFolder.title);
  const ul = $('list');
  ul.replaceChildren(...openFolder.tracks.map((t, i) => {
    // Track titles usually repeat the album name; show just the number then.
    const base = cleanTitle(openFolder.title);
    const label = t.title.startsWith(base) ? `Discourse ${String(t.n).padStart(2, '0')}` : t.title;
    const li = row(cur.series === openFolder && cur.i === i ? 'on' : '', label, t.dur, () => {
      load(openFolder, i, { play: true });
      showLibrary(false);
    });
    const btn = document.createElement('button');
    btn.className = 'dl';
    btn.title = 'Download to play offline';
    btn.onclick = e => { e.stopPropagation(); toggleSave(t.file); };
    rowBtns.set(t.file, btn);
    li.append(btn);
    return li;
  }));
  renderSave();
}

// ---------- boot ----------

async function boot() {
  $('vol').value = audio.volume = saved.vol ?? 1;
  setRate(saved.rate || 0);
  if (navigator.serviceWorker) navigator.serviceWorker.register('/sw.js').catch(() => {});
  try {
    for (const r of await (await caches.open(AUDIO_CACHE)).keys()) offline.add(new URL(r.url).searchParams.get('f'));
  } catch {}
  try {
    let res = await fetch('/api/catalog');
    // First run: the server is still crawling oshoworld.com.
    for (let n = 0; res.status === 503 && n < 120; n++) {
      $('album').textContent = 'Fetching discourses from oshoworld…';
      await new Promise(r => setTimeout(r, 3000));
      res = await fetch('/api/catalog');
    }
    series = (await res.json()).series;
  } catch {
    $('album').textContent = 'Could not load the catalog';
    return;
  }
  const s = series.find(x => x.slug === saved.series);
  if (s && s.tracks[saved.i]) load(s, saved.i, { at: saved.t || 0 });
  else { $('album').textContent = `${series.length} folders ready · open the library`; }
}
boot();
